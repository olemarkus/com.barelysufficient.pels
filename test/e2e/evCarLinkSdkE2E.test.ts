// SDK-boundary e2e for the EV car-to-charger link probe.
//
// WHAT THIS PROBES: a class `car` device — which PELS otherwise drops entirely at
// `SUPPORTED_DEVICE_CLASSES` — is nonetheless observed, correlated against a real
// EV charger's plug transitions, and reported through structured logs. And that
// the probe stays a probe: no capability is ever written to the car, and the
// charger's `stateOfCharge` is never populated from the car's reading.
//
// HOW IT IS SIMULATED: through real Homey signals only — official capabilities
// (`ev_charging_state`, `measure_battery` on the car; `evcharger_charging`,
// `evcharger_charging_state`, `measure_power` on the charger), the real device
// fetch, and the real clock. No PELS internal is mocked; the probe is observed
// through its structured log output and through `api.put` capability writes.
//
// State changes are delivered through `injectDeviceUpdateForTest`, which is the
// live feed's own callback seam — the same `device.update` payload socket.io
// hands the transport in production, and the ONLY path that carries a class
// `car` device at realtime cadence (the periodic snapshot refresh runs at :25
// and :55, far coarser than the 90 s coincidence window).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mockHomeyInstance, setMockDrivers, MockDevice, MockDriver } from '../mocks/homey';
import { createApp, cleanupApps, getLatestTargetSnapshotForTests } from '../utils/appTestUtils';
import {
  CAPACITY_DRY_RUN,
  CAPACITY_LIMIT_KW,
  CAPACITY_MARGIN_KW,
  OPERATING_MODE_SETTING,
} from '../../lib/utils/settingsKeys';
import { drainUntil } from '../utils/asyncDrain';

const POLL_MS = 10_000;
const CAR_ID = 'polestar';
const CHARGER_ID = 'elbillader';

type LinkEvent = {
  event?: string;
  carId?: string;
  chargerId?: string;
  source?: string;
  subReason?: string;
  stoppedAtSocPct?: number | null;
  carSocPct?: number;
  reportedSocPct?: number | null;
  deltaPct?: number | null;
};

const driveHomeEnergy = (netW: number): void => {
  const originalGet = mockHomeyInstance.api.get.bind(mockHomeyInstance.api);
  vi.spyOn(mockHomeyInstance.api, 'get').mockImplementation(async (path: string) => {
    if (path === 'manager/energy/live') {
      return { items: [{ type: 'cumulative', values: { W: netW } }] };
    }
    return originalGet(path);
  });
};

const flushDetached = async (rounds = 12): Promise<void> => {
  for (let i = 0; i < rounds; i += 1) {
    await vi.advanceTimersByTimeAsync(0);
    await new Promise<void>((resolve) => { process.nextTick(resolve); });
  }
};

/** The Polestar-shaped car device: official capabilities only. */
const buildCar = async (): Promise<MockDevice> => {
  const car = new MockDevice(CAR_ID, 'Polestar', ['ev_charging_state', 'measure_battery'], 'car');
  await car.setCapabilityValue('ev_charging_state', 'plugged_out');
  await car.setCapabilityValue('measure_battery', 40);
  return car;
};

const buildCharger = async (): Promise<MockDevice> => {
  const charger = new MockDevice(
    CHARGER_ID,
    'Elbillader',
    ['evcharger_charging', 'evcharger_charging_state', 'measure_power'],
    'evcharger',
  );
  await charger.setCapabilityValue('evcharger_charging', false);
  await charger.setCapabilityValue('evcharger_charging_state', 'plugged_out');
  await charger.setCapabilityValue('measure_power', 0);
  return charger;
};

const seedSettings = (): void => {
  mockHomeyInstance.settings.set('power_source', 'homey_energy');
  mockHomeyInstance.settings.set(CAPACITY_LIMIT_KW, 20);
  mockHomeyInstance.settings.set(CAPACITY_MARGIN_KW, 0);
  mockHomeyInstance.settings.set(CAPACITY_DRY_RUN, false);
  mockHomeyInstance.settings.set(OPERATING_MODE_SETTING, 'Home');
  // Only the charger is managed. The car is never opted in by the user and is
  // not even a supported class — the probe has to find it regardless.
  mockHomeyInstance.settings.set('controllable_devices', { [CHARGER_ID]: true });
  mockHomeyInstance.settings.set('managed_devices', { [CHARGER_ID]: true });
  mockHomeyInstance.settings.set('capacity_priorities', { Home: { [CHARGER_ID]: 1 } });
};

describe('EV car-to-charger link probe (SDK-boundary e2e)', () => {
  let events: LinkEvent[];

  const spyLogs = (app: { log: (...args: unknown[]) => void }): void => {
    const origLog = app.log.bind(app);
    // eslint-disable-next-line no-param-reassign -- intentional test log spy
    app.log = (...args: unknown[]) => {
      for (const arg of args) {
        if (typeof arg !== 'string') continue;
        try {
          const parsed = JSON.parse(arg) as LinkEvent;
          if (typeof parsed.event === 'string' && parsed.event.startsWith('ev_car_')) events.push(parsed);
        } catch { /* non-JSON log line */ }
      }
      return origLog(...args);
    };
  };

  const of = (event: string): LinkEvent[] => events.filter((entry) => entry.event === event);

  /**
   * Deliver the devices' current payloads through the live feed's callback seam,
   * exactly as socket.io does in production.
   */
  const push = async (
    app: { deviceManager?: { injectDeviceUpdateForTest: (device: unknown) => void } },
    ...devices: MockDevice[]
  ): Promise<void> => {
    for (const device of devices) {
      app.deviceManager?.injectDeviceUpdateForTest(device.toHomeyApiDevice());
    }
    await flushDetached();
  };

  const pump = async (polls: number): Promise<void> => {
    for (let i = 0; i < polls; i += 1) {
      await vi.advanceTimersByTimeAsync(POLL_MS);
      await flushDetached();
    }
  };

  beforeEach(() => {
    events = [];
    vi.useFakeTimers({
      toFake: ['Date', 'setTimeout', 'setInterval', 'setImmediate', 'clearTimeout', 'clearInterval', 'clearImmediate'],
    });
    mockHomeyInstance.settings.removeAllListeners();
    mockHomeyInstance.settings.clear();
    mockHomeyInstance.flow._actionCardListeners = {};
    mockHomeyInstance.flow._conditionCardListeners = {};
    mockHomeyInstance.flow._triggerCardRunListeners = {};
    mockHomeyInstance.flow._triggerCardTriggers = {};
    mockHomeyInstance.flow._triggerCardAutocompleteListeners = {};
  });

  afterEach(async () => {
    await cleanupApps();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('links the car to the charger from a coincident plug-in, then reports the car stopping on its own', async () => {
    vi.setSystemTime(Date.UTC(2026, 0, 15, 22, 0, 0));
    const car = await buildCar();
    const charger = await buildCharger();
    setMockDrivers({ driverA: new MockDriver('driverA', [car, charger]) });
    seedSettings();
    driveHomeEnergy(3_000);

    const putSpy = vi.spyOn(mockHomeyInstance.api, 'put');
    const app = createApp();
    spyLogs(app);
    await app.onInit();

    // Both sides observed at least once, so later changes read as plug edges
    // rather than first observations.
    await pump(3);
    await push(app, car, charger);

    // Plug in: both devices transition within the coincidence window.
    await car.setCapabilityValue('ev_charging_state', 'plugged_in_charging');
    await charger.setCapabilityValue('evcharger_charging_state', 'plugged_in_charging');
    await charger.setCapabilityValue('evcharger_charging', true);
    await charger.setCapabilityValue('measure_power', 7_000);
    await push(app, car, charger);

    // Past the settle window (90 s) so the pairing can be decided.
    await pump(12);
    await push(app, car, charger);
    await drainUntil(() => of('ev_car_link_resolved').length > 0);

    const resolved = of('ev_car_link_resolved');
    expect(resolved[0]).toMatchObject({
      carId: CAR_ID,
      chargerId: CHARGER_ID,
      source: 'coincidence',
    });

    // The car reaches its own charge limit: still connected, no longer charging,
    // while the charger still reports a live session and draw collapses.
    await car.setCapabilityValue('measure_battery', 80);
    await car.setCapabilityValue('ev_charging_state', 'plugged_in');
    await charger.setCapabilityValue('measure_power', 0);
    await push(app, car, charger);

    // Past the self-stop dwell (120 s).
    await pump(18);
    await push(app, car, charger);
    await drainUntil(() => of('ev_car_self_stopped').length > 0);

    expect(of('ev_car_self_stopped')[0]).toMatchObject({
      carId: CAR_ID,
      chargerId: CHARGER_ID,
      subReason: 'car_not_charging',
      stoppedAtSocPct: 80,
    });

    // The probe never writes to the car.
    const carWrites = putSpy.mock.calls.filter(([path]: unknown[]) => (
      typeof path === 'string' && path.startsWith(`manager/devices/device/${CAR_ID}/capability/`)
    ));
    expect(carWrites).toEqual([]);

    // And never adopts the reading onto the charger's state-of-charge.
    const snapshot = getLatestTargetSnapshotForTests();
    const chargerSnapshot = snapshot.find((device) => device.id === CHARGER_ID);
    expect(chargerSnapshot).toBeDefined();
    expect((chargerSnapshot as { stateOfCharge?: unknown }).stateOfCharge).toBeUndefined();

    // The car itself stays out of the managed snapshot entirely.
    expect(snapshot.find((device) => device.id === CAR_ID)).toBeUndefined();
  });

  it('reports a session elsewhere when the car plugs in with no charger transition', async () => {
    vi.setSystemTime(Date.UTC(2026, 0, 15, 22, 0, 0));
    const car = await buildCar();
    const charger = await buildCharger();
    setMockDrivers({ driverA: new MockDriver('driverA', [car, charger]) });
    seedSettings();
    driveHomeEnergy(3_000);

    const app = createApp();
    spyLogs(app);
    await app.onInit();
    await pump(3);
    await push(app, car, charger);

    // Car charges at work: the home charger never moves.
    await car.setCapabilityValue('ev_charging_state', 'plugged_in_charging');
    await push(app, car, charger);
    await pump(12);
    await push(app, car, charger);
    await drainUntil(() => of('ev_car_session_elsewhere').length > 0);

    expect(of('ev_car_session_elsewhere')[0]).toMatchObject({ carId: CAR_ID });
    // No link, so no vote was cast for this pair.
    expect(of('ev_car_link_resolved')).toEqual([]);
  });
});
