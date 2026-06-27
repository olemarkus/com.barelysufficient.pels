// SDK-boundary e2e for the home battery as a MANAGED OBSERVE-ONLY device.
//
// WHAT THIS PROBES (PR-C): a role-detected home battery (class:'battery') is TRACKED
// by PELS — it rides the managed snapshot (`managed: true, controllable: false`) and
// its SoC + signed power are observed and logged as `battery_state_observed` — but is
// NEVER actuated: PELS never writes any capability (no set_temperature / set_step /
// onoff) to the battery, even under capacity pressure that sheds a real controllable
// device, and across a charge/discharge swing. The battery power also never feeds the
// hard-cap import path. (The price-hour no-actuation invariant — a battery is
// non-temperature, so price optimization can never write it — is proven
// deterministically at the planner layer in
// `test/integration/batteryManagedExclusion.test.ts`.)
//
// HOW THE BATTERY IS SIMULATED: through its real Homey signals — a DEVICE with
// class:'battery' exposing `measure_battery` (SoC %) and `measure_power` (signed W).
// No PELS internal is mocked. Driven by the real Homey Energy poll + device caps;
// observed by `api.put` capability writes, the `battery_state_observed` log, and the
// committed managed snapshot read back through the test seam (persisted state).
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
const BATTERY_ID = 'battery1';
const EV_ID = 'ev';
const ONOFF_CAP = (deviceId: string) => `manager/devices/device/${deviceId}/capability/onoff`;

const EV_DRAW_W = 2000;
const TRUE_TOTAL_W = 3000; // 3.0 kW net household consumption

type PlanRebuildEvent = { event?: string; totalKw?: number };
type BatteryStateEvent = {
  event?: string;
  batterySoc?: number;
  batteryPowerW?: number;
  batteryDeviceCount?: number;
};

// Drive `manager/energy/live` with a fixed net watt value (the grid import path). The
// battery does NOT change this — it is a separate device signal.
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

// A home-battery DEVICE: class 'battery' with SoC + signed power.
const buildBattery = async (soc: number, powerW: number): Promise<MockDevice> => {
  const battery = new MockDevice(BATTERY_ID, 'Home Battery', ['measure_battery', 'measure_power'], 'battery');
  await battery.setCapabilityValue('measure_battery', soc);
  await battery.setCapabilityValue('measure_power', powerW);
  return battery;
};

const seedSettings = (capKw: number): void => {
  mockHomeyInstance.settings.set('power_source', 'homey_energy');
  mockHomeyInstance.settings.set(CAPACITY_LIMIT_KW, capKw);
  mockHomeyInstance.settings.set(CAPACITY_MARGIN_KW, 0);
  mockHomeyInstance.settings.set(CAPACITY_DRY_RUN, false);
  mockHomeyInstance.settings.set(OPERATING_MODE_SETTING, 'Home');
  // The user never opts the battery into managed/controllable — only the EV. The
  // battery becomes managed (observe-only) purely from its role detection.
  mockHomeyInstance.settings.set('controllable_devices', { [EV_ID]: true });
  mockHomeyInstance.settings.set('managed_devices', { [EV_ID]: true });
  mockHomeyInstance.settings.set('capacity_priorities', { Home: { [EV_ID]: 1 } });
  mockHomeyInstance.settings.set(OVERSHOOT_BEHAVIORS, { [EV_ID]: { action: 'turn_off' } });
};

describe('Home battery as managed observe-only (SDK-boundary e2e)', () => {
  let batteryEvents: BatteryStateEvent[];
  let planEvents: PlanRebuildEvent[];

  const spyLogs = (app: { log: (...args: unknown[]) => void }): void => {
    const origLog = app.log.bind(app);
    // eslint-disable-next-line no-param-reassign -- intentional test log spy
    app.log = (...args: unknown[]) => {
      for (const arg of args) {
        if (typeof arg !== 'string') continue;
        try {
          const parsed = JSON.parse(arg) as { event?: string };
          if (parsed.event === 'battery_state_observed') batteryEvents.push(parsed as BatteryStateEvent);
          if (parsed.event === 'plan_rebuild_completed') planEvents.push(parsed as PlanRebuildEvent);
        } catch { /* non-JSON log line */ }
      }
      return origLog(...args);
    };
  };

  const latestBattery = (): BatteryStateEvent | undefined =>
    [...batteryEvents].reverse().find((e) => e.batterySoc !== undefined && e.batteryPowerW !== undefined);
  const latestCapView = (): PlanRebuildEvent | undefined =>
    [...planEvents].reverse().find((e) => typeof e.totalKw === 'number');
  const batteryWasActuated = (putSpy: ReturnType<typeof vi.spyOn>): boolean =>
    putSpy.mock.calls.some(([path]: unknown[]) =>
      typeof path === 'string' && path.startsWith(`manager/devices/device/${BATTERY_ID}/capability/`));

  beforeEach(() => {
    batteryEvents = [];
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

  // (a) The battery is TRACKED: observed read-only AND present in the managed snapshot
  // as managed:true / controllable:false — yet never actuated, with a cap far above
  // any total so capacity shedding never fires.
  it('rides the managed snapshot (managed, non-controllable) and is observed, never actuated', async () => {
    vi.setSystemTime(Date.UTC(2026, 0, 15, 12, 5, 0));
    setMockDrivers({ driverA: new MockDriver('driverA', [await buildEv(), await buildBattery(62, 1200)]) });
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
    await drainUntil(() => latestBattery()?.batterySoc === 62);

    // Observed read-only.
    expect(latestBattery()).toMatchObject({ batterySoc: 62, batteryPowerW: 1200, batteryDeviceCount: 1 });

    // Rides the managed snapshot as managed observe-only.
    const managedSnapshot = getLatestTargetSnapshotForTests();
    const battery = managedSnapshot.find((d) => d.id === BATTERY_ID);
    expect(battery).toBeDefined();
    expect(battery?.managed).toBe(true);
    expect(battery?.controllable).toBe(false);

    // Appears EXACTLY once in the settings-UI payload: in the managed list, and NOT in
    // the device picker (a battery's "manage" toggle is a no-op, so it must not also
    // render as an unmanaged-eligible pick).
    const pickerIds = ((app as unknown as { getUiPickerDevices: () => Array<{ id: string }> })
      .getUiPickerDevices() ?? []).map((d) => d.id);
    expect(pickerIds).not.toContain(BATTERY_ID);
    const settingsUiIds = [...managedSnapshot.map((d) => d.id), ...pickerIds];
    expect(settingsUiIds.filter((id) => id === BATTERY_ID)).toHaveLength(1);

    // Never actuated.
    expect(batteryWasActuated(putSpy)).toBe(false);
  });

  // (b) Under capacity PRESSURE that sheds the real controllable EV, the battery STILL
  // receives no actuation — the control gates exclude it.
  it('never receives actuation even when capacity pressure sheds the controllable EV', async () => {
    vi.setSystemTime(Date.UTC(2026, 0, 15, 13, 5, 0));
    setMockDrivers({ driverA: new MockDriver('driverA', [await buildEv(), await buildBattery(70, 1500)]) });
    seedSettings(1); // cap 1.0 kW — well below the 3.0 kW total, so the EV is shed
    driveHomeEnergy({ netW: TRUE_TOTAL_W });

    const putSpy = vi.spyOn(mockHomeyInstance.api, 'put');
    const app = createApp();
    spyLogs(app);
    await app.onInit();
    await vi.advanceTimersByTimeAsync(POLL_MS);
    // The EV IS shed (proves capacity pressure is real, not vacuous).
    await drainUntilCalledWith(putSpy, ONOFF_CAP(EV_ID), { value: false });

    expect(putSpy).toHaveBeenCalledWith(ONOFF_CAP(EV_ID), { value: false });
    // The battery is NEVER written to, by any capability.
    expect(batteryWasActuated(putSpy)).toBe(false);
  });

  // (c) READ-ONLY ISOLATION: a charging-then-discharging battery NEVER alters the
  // hard-cap / capacity view. Every plan-rebuild totalKw tracks NET grid import only.
  it('battery power never alters the capacity (hard-cap) view across a charge/discharge swing', async () => {
    vi.setSystemTime(Date.UTC(2026, 0, 15, 14, 5, 0));
    const battery = await buildBattery(62, 1200); // charging
    setMockDrivers({ driverA: new MockDriver('driverA', [await buildEv(), battery]) });
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
    await drainUntil(() => latestCapView()?.totalKw !== undefined && latestBattery()?.batterySoc === 62);

    const capWhileCharging = latestCapView();
    expect(capWhileCharging?.totalKw).toBeCloseTo(TRUE_TOTAL_W / 1000, 2); // 3.0 kW NET, not net+battery

    // Flip to a strong discharge. The discharge must change NOTHING the planner sees.
    await battery.setCapabilityValue('measure_power', -2500);
    for (let i = 0; i < 6; i += 1) {
      await vi.advanceTimersByTimeAsync(POLL_MS);
      await flushDetached();
    }
    await drainUntil(() => latestCapView()?.totalKw !== undefined);

    // Across the entire charge->discharge swing, every plan event ever emitted shows
    // the net 3.0 kW — never net+battery (which would be 4.2 / 0.5 kW) — and the
    // battery is never actuated.
    expect(planEvents.length).toBeGreaterThan(0);
    for (const plan of planEvents) {
      expect(plan.totalKw).toBeCloseTo(TRUE_TOTAL_W / 1000, 2);
    }
    expect(batteryWasActuated(putSpy)).toBe(false);
  });

  // (d) Absence emits NOTHING: with no battery device present, no
  // battery_state_observed event is ever produced.
  it('emits no battery_state_observed event when no battery is present', async () => {
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
    expect(batteryEvents).toEqual([]);
  });
});
