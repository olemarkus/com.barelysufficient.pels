// SDK-boundary e2e for a solar / PV device as a MANAGED OBSERVE-ONLY device.
//
// WHAT THIS PROBES (PR-D): a role-detected solar device (class:'solarpanel') is TRACKED
// by PELS — it rides the managed snapshot (`managed: true, controllable: false`) and its
// production is observed and logged as `solar_production_observed` — but is NEVER
// actuated, even under capacity pressure that sheds a real controllable device. The
// solar device's POSITIVE production also never feeds the hard-cap / capacity view (which
// stays on net grid `cumulative.W`) and is never counted as device consumption.
//
// HOW THE SOLAR DEVICE IS SIMULATED: through its real Homey signals — a DEVICE with
// class:'solarpanel' exposing `measure_power` (POSITIVE when producing) and `meter_power`
// (kWh generated). No PELS internal is mocked.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mockHomeyInstance, setMockDrivers, MockDevice, MockDriver } from '../mocks/homey';
import {
  createApp,
  cleanupApps,
  getLatestTargetSnapshotForTests,
} from '../utils/appTestUtils';
import {
  CAPACITY_DRY_RUN,
  CAPACITY_LIMIT_KW,
  CAPACITY_MARGIN_KW,
  OPERATING_MODE_SETTING,
  OVERSHOOT_BEHAVIORS,
} from '../../lib/utils/settingsKeys';
import { drainUntil, drainUntilCalledWith } from '../utils/asyncDrain';

const POLL_MS = 10_000;
const SOLAR_ID = 'solar1';
const EV_ID = 'ev';
const ONOFF_CAP = (deviceId: string) => `manager/devices/device/${deviceId}/capability/onoff`;

const EV_DRAW_W = 2000;
const TRUE_TOTAL_W = 3000; // 3.0 kW net household consumption (grid import)

// Drive `manager/energy/live` with a fixed net watt value (the grid import path). The
// solar device does NOT change this — it is a separate device signal.
const driveHomeEnergy = (initial: { netW: number }) => {
  let state = initial;
  const originalGet = mockHomeyInstance.api.get.bind(mockHomeyInstance.api);
  vi.spyOn(mockHomeyInstance.api, 'get').mockImplementation(async (path: string) => {
    if (path === 'manager/energy/live') {
      return { items: [{ type: 'cumulative', values: { W: state.netW } }] };
    }
    return originalGet(path);
  });
  return (next: { netW: number }) => { state = next; };
};

const flushDetached = async (rounds = 12): Promise<void> => {
  for (let i = 0; i < rounds; i += 1) {
    await vi.advanceTimersByTimeAsync(0);
    await new Promise<void>((resolve) => { process.nextTick(resolve); });
  }
};

const buildEv = async (): Promise<MockDevice> => {
  const ev = new MockDevice(EV_ID, 'EV charger', ['onoff', 'measure_power', 'meter_power'], 'socket');
  await ev.setCapabilityValue('onoff', true);
  await ev.setCapabilityValue('measure_power', EV_DRAW_W);
  return ev;
};

// A solar DEVICE: class 'solarpanel' with POSITIVE production power + generated kWh.
const buildSolar = async (productionW: number): Promise<MockDevice> => {
  const solar = new MockDevice(SOLAR_ID, 'Solar Panel', ['measure_power', 'meter_power'], 'solarpanel');
  await solar.setCapabilityValue('measure_power', productionW);
  await solar.setCapabilityValue('meter_power', 42);
  return solar;
};

const seedSettings = (capKw: number): void => {
  mockHomeyInstance.settings.set('power_source', 'homey_energy');
  mockHomeyInstance.settings.set(CAPACITY_LIMIT_KW, capKw);
  mockHomeyInstance.settings.set(CAPACITY_MARGIN_KW, 0);
  mockHomeyInstance.settings.set(CAPACITY_DRY_RUN, false);
  mockHomeyInstance.settings.set(OPERATING_MODE_SETTING, 'Home');
  // The user never opts the solar device into managed/controllable — only the EV. The
  // solar device becomes managed (observe-only) purely from its role detection.
  mockHomeyInstance.settings.set('controllable_devices', { [EV_ID]: true });
  mockHomeyInstance.settings.set('managed_devices', { [EV_ID]: true });
  mockHomeyInstance.settings.set('capacity_priorities', { Home: { [EV_ID]: 1 } });
  mockHomeyInstance.settings.set(OVERSHOOT_BEHAVIORS, { [EV_ID]: { action: 'turn_off' } });
};

type PlanRebuildEvent = { event?: string; totalKw?: number };
type SolarEvent = { event?: string; productionW?: number; solarDeviceCount?: number };

describe('Solar device as managed observe-only (SDK-boundary e2e)', () => {
  let solarEvents: SolarEvent[];
  let planEvents: PlanRebuildEvent[];

  const spyLogs = (app: { log: (...args: unknown[]) => void }): void => {
    const origLog = app.log.bind(app);
    // eslint-disable-next-line no-param-reassign -- intentional test log spy
    app.log = (...args: unknown[]) => {
      for (const arg of args) {
        if (typeof arg !== 'string') continue;
        try {
          const parsed = JSON.parse(arg) as { event?: string };
          if (parsed.event === 'solar_production_observed') solarEvents.push(parsed as SolarEvent);
          if (parsed.event === 'plan_rebuild_completed') planEvents.push(parsed as PlanRebuildEvent);
        } catch { /* non-JSON log line */ }
      }
      return origLog(...args);
    };
  };

  const latestSolar = (): SolarEvent | undefined =>
    [...solarEvents].reverse().find((e) => e.productionW !== undefined);
  const latestCapView = (): PlanRebuildEvent | undefined =>
    [...planEvents].reverse().find((e) => typeof e.totalKw === 'number');
  const solarWasActuated = (putSpy: ReturnType<typeof vi.spyOn>): boolean =>
    putSpy.mock.calls.some(([path]: unknown[]) =>
      typeof path === 'string' && path.startsWith(`manager/devices/device/${SOLAR_ID}/capability/`));

  beforeEach(() => {
    solarEvents = [];
    planEvents = [];
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

  // (a) TRACKED: observed read-only AND present in the managed snapshot as
  // managed:true / controllable:false — yet never actuated.
  it('rides the managed snapshot (managed, non-controllable) and is observed, never actuated', async () => {
    vi.setSystemTime(Date.UTC(2026, 0, 15, 12, 5, 0));
    setMockDrivers({ driverA: new MockDriver('driverA', [await buildEv(), await buildSolar(3000)]) });
    seedSettings(20); // cap well above 3.0 kW total — no shedding
    driveHomeEnergy({ netW: TRUE_TOTAL_W });

    const putSpy = vi.spyOn(mockHomeyInstance.api, 'put');
    const app = createApp();
    spyLogs(app);
    await app.onInit();

    for (let i = 0; i < 12; i += 1) {
      await vi.advanceTimersByTimeAsync(POLL_MS);
      await flushDetached();
    }
    await drainUntil(() => latestSolar()?.productionW === 3000);

    // Observed read-only.
    expect(latestSolar()).toMatchObject({ productionW: 3000, solarDeviceCount: 1 });

    // Rides the managed snapshot as managed observe-only.
    const managedSnapshot = getLatestTargetSnapshotForTests();
    const solar = managedSnapshot.find((d) => d.id === SOLAR_ID);
    expect(solar).toBeDefined();
    expect(solar?.managed).toBe(true);
    expect(solar?.controllable).toBe(false);

    // Appears EXACTLY once in the settings-UI payload (managed list, NOT the picker).
    const pickerIds = ((app as unknown as { getUiPickerDevices: () => Array<{ id: string }> })
      .getUiPickerDevices() ?? []).map((d) => d.id);
    expect(pickerIds).not.toContain(SOLAR_ID);
    const settingsUiIds = [...managedSnapshot.map((d) => d.id), ...pickerIds];
    expect(settingsUiIds.filter((id) => id === SOLAR_ID)).toHaveLength(1);

    // Never actuated.
    expect(solarWasActuated(putSpy)).toBe(false);
  });

  // (b) Under capacity PRESSURE that sheds the real controllable EV, the solar device
  // STILL receives no actuation — the control gates exclude it.
  it('never receives actuation even when capacity pressure sheds the controllable EV', async () => {
    vi.setSystemTime(Date.UTC(2026, 0, 15, 13, 5, 0));
    setMockDrivers({ driverA: new MockDriver('driverA', [await buildEv(), await buildSolar(2500)]) });
    seedSettings(1); // cap 1.0 kW — well below the 3.0 kW total, so the EV is shed
    driveHomeEnergy({ netW: TRUE_TOTAL_W });

    const putSpy = vi.spyOn(mockHomeyInstance.api, 'put');
    const app = createApp();
    spyLogs(app);
    await app.onInit();
    await vi.advanceTimersByTimeAsync(POLL_MS);
    await drainUntilCalledWith(putSpy, ONOFF_CAP(EV_ID), { value: false });

    expect(putSpy).toHaveBeenCalledWith(ONOFF_CAP(EV_ID), { value: false });
    // The solar device is NEVER written to, by any capability.
    expect(solarWasActuated(putSpy)).toBe(false);
  });

  // (c) READ-ONLY ISOLATION: solar production NEVER alters the hard-cap / capacity view.
  // Every plan-rebuild totalKw tracks NET grid import only — never net − production.
  it('solar production never alters the capacity (hard-cap) view across a production swing', async () => {
    vi.setSystemTime(Date.UTC(2026, 0, 15, 14, 5, 0));
    const solar = await buildSolar(3000);
    setMockDrivers({ driverA: new MockDriver('driverA', [await buildEv(), solar]) });
    seedSettings(20);
    driveHomeEnergy({ netW: TRUE_TOTAL_W });

    const putSpy = vi.spyOn(mockHomeyInstance.api, 'put');
    const app = createApp();
    spyLogs(app);
    await app.onInit();

    for (let i = 0; i < 6; i += 1) {
      await vi.advanceTimersByTimeAsync(POLL_MS);
      await flushDetached();
    }
    await drainUntil(() => latestCapView()?.totalKw !== undefined && latestSolar()?.productionW === 3000);

    const capWhileProducing = latestCapView();
    expect(capWhileProducing?.totalKw).toBeCloseTo(TRUE_TOTAL_W / 1000, 2); // 3.0 kW NET

    // Swing production hard. The cap view must change NOTHING the planner sees.
    await solar.setCapabilityValue('measure_power', 6000);
    for (let i = 0; i < 6; i += 1) {
      await vi.advanceTimersByTimeAsync(POLL_MS);
      await flushDetached();
    }
    await drainUntil(() => latestCapView()?.totalKw !== undefined);

    // Across the entire production swing, every plan event ever emitted shows the net
    // 3.0 kW — never net ± production — and the solar device is never actuated.
    expect(planEvents.length).toBeGreaterThan(0);
    for (const plan of planEvents) {
      expect(plan.totalKw).toBeCloseTo(TRUE_TOTAL_W / 1000, 2);
    }
    expect(solarWasActuated(putSpy)).toBe(false);
  });

  // (d) Absence emits NOTHING: with no solar device present, no solar_production_observed.
  it('emits no solar_production_observed event when no solar device is present', async () => {
    vi.setSystemTime(Date.UTC(2026, 0, 15, 15, 5, 0));
    setMockDrivers({ driverA: new MockDriver('driverA', [await buildEv()]) });
    seedSettings(20);
    driveHomeEnergy({ netW: TRUE_TOTAL_W });

    const app = createApp();
    spyLogs(app);
    await app.onInit();

    for (let i = 0; i < 12; i += 1) {
      await vi.advanceTimersByTimeAsync(POLL_MS);
      await flushDetached();
    }
    await drainUntil(() => latestCapView()?.totalKw !== undefined);
    expect(solarEvents).toEqual([]);
  });
});
