// SDK-boundary e2e for the EV car-to-charger link probe.
//
// WHAT THIS PROBES: a class `car` device — which PELS otherwise drops entirely at
// `SUPPORTED_DEVICE_CLASSES` — is nonetheless observed, correlated against a real
// EV charger's plug transitions, and reported through structured logs. The probe
// still writes nothing to the CAR, and a charger the user has not opted in keeps
// its `stateOfCharge` entirely its own — that arm is what protects every
// existing install. Opting a charger in is what lets the car's level become the
// charger's.
//
// HOW IT IS SIMULATED: through real Homey signals only — official capabilities
// (`ev_charging_state`, `measure_battery` on the car; `evcharger_charging`,
// `evcharger_charging_state`, `measure_power` on the charger), the real device
// fetch, and the real clock. No PELS internal is mocked; the probe is observed
// through its structured log output and through `api.put` capability writes.
//
// State changes are delivered ONLY by mutating the mock devices and letting the
// app's own periodic snapshot refresh (:25 and :55) read them back through
// `manager/devices/device`. No internal hook is called: the probe has to pick a
// class `car` device out of the raw fetch itself, which is the path that keeps
// working when the live feed is down.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mockHomeyInstance, setMockDrivers, MockDevice, MockDriver } from '../mocks/homey';
import { createApp, cleanupApps, getLatestTargetSnapshotForTests } from '../utils/appTestUtils';
import {
  CAPACITY_DRY_RUN,
  CAPACITY_LIMIT_KW,
  CAPACITY_MARGIN_KW,
  EV_CAR_ASSOCIATIONS,
  OPERATING_MODE_SETTING,
} from '../../lib/utils/settingsKeys';
import api from '../../api';
import type { DecoratedDeviceSnapshot } from '../../packages/contracts/src/types';
import { drainUntil } from '../utils/asyncDrain';

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

  /** The charger's state-of-charge as transport currently holds it. */
  const socOf = (snapshot: ReturnType<typeof getLatestTargetSnapshotForTests>) => (
    (snapshot.find((device) => device.id === CHARGER_ID) as {
      stateOfCharge?: { percent: number; source?: string; sourceDeviceId?: string; status: string };
    } | undefined)?.stateOfCharge
  );

  /**
   * The charger as the settings UI receives it — through the registered
   * `ui_devices` endpoint handler, not the composer beneath it, so endpoint
   * registration and routing are part of what this asserts.
   */
  const chargerFromUi = async (): Promise<DecoratedDeviceSnapshot> => {
    const payload = await api.ui_devices({ homey: mockHomeyInstance as never });
    const charger = payload.devices.find((device: DecoratedDeviceSnapshot) => device.id === CHARGER_ID);
    if (!charger) throw new Error('charger missing from the settings-UI devices payload');
    return charger;
  };

  /** Advance `minutes` of app time, flushing detached work as timers fire. */
  const pumpMinutes = async (minutes: number): Promise<void> => {
    for (let i = 0; i < minutes; i += 1) {
      await vi.advanceTimersByTimeAsync(60_000);
      await flushDetached(4);
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
    vi.setSystemTime(Date.UTC(2026, 0, 15, 22, 15, 0));
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
    await pumpMinutes(2);

    // Plug in. Both devices change together; the :25 refresh reads both.
    await car.setCapabilityValue('ev_charging_state', 'plugged_in_charging');
    await charger.setCapabilityValue('evcharger_charging_state', 'plugged_in_charging');
    await charger.setCapabilityValue('evcharger_charging', true);
    await charger.setCapabilityValue('measure_power', 7_000);
    await pumpMinutes(8);

    // The :55 refresh is past the settle window, so the pairing can be decided.
    await pumpMinutes(32);
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

    // Two more refreshes: the first sees the stop, the second is past the dwell.
    await pumpMinutes(62);
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

    // With no car ticked for this charger, its state-of-charge stays untouched —
    // the default every existing install runs on.
    const snapshot = getLatestTargetSnapshotForTests();
    const chargerSnapshot = snapshot.find((device) => device.id === CHARGER_ID);
    expect(chargerSnapshot).toBeDefined();
    expect((chargerSnapshot as { stateOfCharge?: unknown }).stateOfCharge).toBeUndefined();

    // The car itself stays out of the managed snapshot entirely.
    expect(snapshot.find((device) => device.id === CAR_ID)).toBeUndefined();
  });

  it('reports a session elsewhere when the car plugs in with no charger transition', async () => {
    vi.setSystemTime(Date.UTC(2026, 0, 15, 22, 15, 0));
    const car = await buildCar();
    const charger = await buildCharger();
    setMockDrivers({ driverA: new MockDriver('driverA', [car, charger]) });
    seedSettings();
    driveHomeEnergy(3_000);

    const app = createApp();
    spyLogs(app);
    await app.onInit();
    await pumpMinutes(2);

    // Car charges at work: the home charger never moves.
    await car.setCapabilityValue('ev_charging_state', 'plugged_in_charging');
    await pumpMinutes(40);
    await drainUntil(() => of('ev_car_session_elsewhere').length > 0);

    expect(of('ev_car_session_elsewhere')[0]).toMatchObject({ carId: CAR_ID });
    // No link, so no vote was cast for this pair.
    expect(of('ev_car_link_resolved')).toEqual([]);
  });

  it('adopts the associated car battery level as the charger state-of-charge', async () => {
    vi.setSystemTime(Date.UTC(2026, 0, 15, 22, 15, 0));
    const car = await buildCar();
    const charger = await buildCharger();
    setMockDrivers({ driverA: new MockDriver('driverA', [car, charger]) });
    seedSettings();
    // The user ticks this car for this charger BEFORE the session, which is the
    // only difference from the first scenario.
    mockHomeyInstance.settings.set(EV_CAR_ASSOCIATIONS, { [CHARGER_ID]: { carIds: [CAR_ID] } });
    driveHomeEnergy(3_000);

    const app = createApp();
    spyLogs(app);
    await app.onInit();
    await pumpMinutes(2);

    await car.setCapabilityValue('ev_charging_state', 'plugged_in_charging');
    await charger.setCapabilityValue('evcharger_charging_state', 'plugged_in_charging');
    await charger.setCapabilityValue('evcharger_charging', true);
    await charger.setCapabilityValue('measure_power', 7_000);
    await pumpMinutes(40);
    await drainUntil(() => of('ev_car_link_resolved').length > 0);

    // A level the car reports DURING the session lands on the charger, without
    // waiting for the next snapshot refresh.
    await car.setCapabilityValue('measure_battery', 63);
    // The reading is queued and drained on the next correlation pass, which the
    // 30 s heartbeat drives — quiet devices produce no telemetry to ride on.
    await pumpMinutes(2);
    await drainUntil(() => socOf(getLatestTargetSnapshotForTests())?.percent === 63);

    expect(socOf(getLatestTargetSnapshotForTests())).toMatchObject({
      percent: 63,
      source: 'car',
      sourceDeviceId: CAR_ID,
      level: { kind: 'known', percent: 63 },
    });

    // Unplug ends the association, and the car's level goes with it: there is no
    // car, so there is no battery to report.
    await car.setCapabilityValue('ev_charging_state', 'plugged_out');
    await charger.setCapabilityValue('evcharger_charging_state', 'plugged_out');
    await charger.setCapabilityValue('evcharger_charging', false);
    await charger.setCapabilityValue('measure_power', 0);
    await pumpMinutes(40);

    expect(socOf(getLatestTargetSnapshotForTests())).toBeUndefined();
  });

  // The association reaches the settings UI through the real `/ui_devices`
  // composer, which is the only consumer. Asserting through that seam (rather
  // than a transport accessor) is what proves the value actually survives to a
  // reader: an earlier design stamped it onto the device snapshot, where the
  // observed-state projection dropped it and every device re-parse wiped it.
  it('serves the associated car to the settings UI only for a car the user ticked', async () => {
    vi.setSystemTime(Date.UTC(2026, 0, 15, 22, 15, 0));
    const car = await buildCar();
    const charger = await buildCharger();
    setMockDrivers({ driverA: new MockDriver('driverA', [car, charger]) });
    seedSettings();
    driveHomeEnergy(3_000);

    const app = createApp();
    spyLogs(app);
    await app.onInit();
    await pumpMinutes(2);

    await car.setCapabilityValue('ev_charging_state', 'plugged_in_charging');
    await charger.setCapabilityValue('evcharger_charging_state', 'plugged_in_charging');
    await charger.setCapabilityValue('evcharger_charging', true);
    await charger.setCapabilityValue('measure_power', 7_000);
    await pumpMinutes(40);
    await drainUntil(() => of('ev_car_link_resolved').length > 0);

    // The probe has matched the pair, but the user has ticked nothing: the
    // default for every existing install must stay invisible.
    expect((await chargerFromUi()).associatedCar).toBeUndefined();

    // Tick the car for this charger.
    mockHomeyInstance.settings.set(EV_CAR_ASSOCIATIONS, { [CHARGER_ID]: { carIds: [CAR_ID] } });
    await flushDetached();

    expect((await chargerFromUi()).associatedCar).toMatchObject({
      carId: CAR_ID,
      carName: 'Polestar',
      chargingState: 'plugged_in_charging',
      socPct: 40,
    });

    // A car the user did NOT tick never associates, even though the probe still
    // holds the same live session for it.
    mockHomeyInstance.settings.set(EV_CAR_ASSOCIATIONS, { [CHARGER_ID]: { carIds: ['some-other-car'] } });
    await flushDetached();
    expect((await chargerFromUi()).associatedCar).toBeUndefined();

    // Unplug: the association ends immediately, without waiting for a refresh.
    mockHomeyInstance.settings.set(EV_CAR_ASSOCIATIONS, { [CHARGER_ID]: { carIds: [CAR_ID] } });
    await flushDetached();
    expect((await chargerFromUi()).associatedCar).toBeDefined();

    // Homey retains cached capability values while a device is unavailable.
    // PELS must stop serving those values immediately, then resume the same
    // connected session once usable telemetry returns — no physical replug.
    car.setAvailable(false);
    await pumpMinutes(30);
    expect((await chargerFromUi()).associatedCar).toBeUndefined();
    expect(socOf(getLatestTargetSnapshotForTests())).toBeUndefined();

    car.setAvailable(true);
    await car.setCapabilityValue('measure_battery', 41);
    await pumpMinutes(30);
    expect((await chargerFromUi()).associatedCar).toMatchObject({
      carId: CAR_ID,
      socPct: 41,
    });
    expect(socOf(getLatestTargetSnapshotForTests())).toMatchObject({
      percent: 41,
      source: 'car',
      sourceDeviceId: CAR_ID,
    });

    await car.setCapabilityValue('ev_charging_state', 'plugged_out');
    await charger.setCapabilityValue('evcharger_charging_state', 'plugged_out');
    await charger.setCapabilityValue('evcharger_charging', false);
    await charger.setCapabilityValue('measure_power', 0);
    await pumpMinutes(40);

    expect((await chargerFromUi()).associatedCar).toBeUndefined();
  });
});
