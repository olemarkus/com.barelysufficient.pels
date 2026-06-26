// SDK-boundary e2e for READ-ONLY home-battery awareness.
//
// WHAT THIS PROBES: PELS observes home-battery DEVICES (SoC + signed power) and
// surfaces them read-only via a structured `battery_state_observed` event. This
// is the sensor foundation for later cap-relief / surplus-routing — but in this
// PR the battery NEVER commands and NEVER touches the hard-cap import path.
//
// HOW THE BATTERY IS SIMULATED: through its real Homey signals — a DEVICE with
// `class: 'battery'` (the canonical home-battery role) exposing `measure_battery`
// (SoC %, 0–100) and `measure_power` (signed W: + charging / − discharging).
// The device is registered through a MockDriver so PELS's snapshot fetch returns
// it. No PELS internal is mocked.
//
// Observation is the SDK seam (driven energy report + driven device caps) and the
// structured logs PELS emits (`battery_state_observed`, `plan_rebuild_completed`).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mockHomeyInstance, setMockDrivers, MockDevice, MockDriver } from '../mocks/homey';
import { createApp, cleanupApps } from '../utils/appTestUtils';
import {
  CAPACITY_DRY_RUN,
  CAPACITY_LIMIT_KW,
  CAPACITY_MARGIN_KW,
  OPERATING_MODE_SETTING,
  OVERSHOOT_BEHAVIORS,
} from '../../lib/utils/settingsKeys';
import { drainUntil } from '../utils/asyncDrain';

const POLL_MS = 10_000;

// One managed EV drawing a steady 2.0 kW at the appliance meter, plus 1.0 kW of
// implicit background. A cap far above any net total so capacity shedding never
// fires — we are testing observation + isolation, not control.
const EV_DRAW_W = 2000;
const TRUE_TOTAL_W = 3000; // 3.0 kW net household consumption
const CAP_KW = 20;

type PlanRebuildEvent = {
  event?: string;
  totalKw?: number;
  hardCapHeadroomKw?: number;
};

type BatteryStateEvent = {
  event?: string;
  batterySoc?: number;
  batteryPowerW?: number;
  batteryDeviceCount?: number;
};

// Drive `manager/energy/live` with a fixed net watt value (the grid import path).
// The battery does NOT change this — it is a separate device signal.
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

// The periodic snapshot refresh fires on the :25 / :55 minute boundaries
// (SNAPSHOT_REFRESH_MINUTE_INTERVALS). Home batteries are re-read on that
// (targeted) refresh, so to observe a SECOND battery reading we must advance
// across a boundary. Tests start at :24 so a few minutes of advance crosses :25.
const SNAPSHOT_START_MINUTE = 24;

// Advance the clock minute-by-minute far enough to cross the next snapshot-refresh
// boundary (worst-case gap :25 -> :55 is 30 minutes), flushing detached work each
// step so the periodic refresh actually runs and re-reads the battery.
const advanceAcrossSnapshotRefresh = async (): Promise<void> => {
  for (let i = 0; i < 31; i += 1) {
    await vi.advanceTimersByTimeAsync(60_000);
    await flushDetached();
  }
};

const buildEv = async (): Promise<MockDevice> => {
  const ev = new MockDevice('ev', 'EV charger', ['onoff', 'measure_power', 'meter_power'], 'socket');
  await ev.setCapabilityValue('onoff', true);
  await ev.setCapabilityValue('measure_power', EV_DRAW_W);
  return ev;
};

// A home-battery DEVICE: class 'battery' (canonical role) with SoC + signed power.
const buildBattery = async (soc: number, powerW: number): Promise<MockDevice> => {
  const battery = new MockDevice('battery1', 'Home Battery', ['measure_battery', 'measure_power'], 'battery');
  await battery.setCapabilityValue('measure_battery', soc);
  await battery.setCapabilityValue('measure_power', powerW);
  return battery;
};

const seedSettings = (): void => {
  mockHomeyInstance.settings.set('power_source', 'homey_energy');
  mockHomeyInstance.settings.set(CAPACITY_LIMIT_KW, CAP_KW);
  mockHomeyInstance.settings.set(CAPACITY_MARGIN_KW, 0);
  mockHomeyInstance.settings.set(CAPACITY_DRY_RUN, false);
  mockHomeyInstance.settings.set(OPERATING_MODE_SETTING, 'Home');
  mockHomeyInstance.settings.set('controllable_devices', { ev: true });
  mockHomeyInstance.settings.set('managed_devices', { ev: true });
  mockHomeyInstance.settings.set('capacity_priorities', { Home: { ev: 1 } });
  mockHomeyInstance.settings.set(OVERSHOOT_BEHAVIORS, { ev: { action: 'turn_off' } });
};

describe('Read-only home-battery awareness (SDK-boundary e2e)', () => {
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

  // (a) A charging battery at 62% / +1200 W is observed and surfaced read-only.
  it('observes a charging battery (SoC + signed power) via battery_state_observed', async () => {
    const hourStartMs = Date.UTC(2026, 0, 15, 12, 0, 0);
    vi.setSystemTime(hourStartMs + 5 * 60 * 1000);

    setMockDrivers({
      driverA: new MockDriver('driverA', [await buildEv(), await buildBattery(62, 1200)]),
    });
    seedSettings();
    driveHomeEnergy({ netW: TRUE_TOTAL_W });

    const app = createApp();
    spyLogs(app);
    await app.onInit();

    for (let i = 0; i < 12; i += 1) {
      await vi.advanceTimersByTimeAsync(POLL_MS);
      await flushDetached();
    }
    await drainUntil(() => latestBattery()?.batterySoc === 62);

    const battery = latestBattery();
    expect(battery?.batterySoc).toBe(62);
    expect(battery?.batteryPowerW).toBe(1200);
    expect(battery?.batteryDeviceCount).toBe(1);
  });

  // (b) Flipping to discharging carries the correct sign and updated SoC.
  it('reflects a discharging battery with the correct power sign', async () => {
    const hourStartMs = Date.UTC(2026, 0, 15, 13, 0, 0);
    vi.setSystemTime(hourStartMs + SNAPSHOT_START_MINUTE * 60 * 1000);

    const battery = await buildBattery(62, 1200);
    setMockDrivers({ driverA: new MockDriver('driverA', [await buildEv(), battery]) });
    seedSettings();
    driveHomeEnergy({ netW: TRUE_TOTAL_W });

    const app = createApp();
    spyLogs(app);
    await app.onInit();

    await vi.advanceTimersByTimeAsync(POLL_MS);
    await flushDetached();
    await drainUntil(() => latestBattery()?.batterySoc === 62);

    // Flip the battery to discharging (SoC drops, power goes negative).
    await battery.setCapabilityValue('measure_battery', 58);
    await battery.setCapabilityValue('measure_power', -1500);

    await advanceAcrossSnapshotRefresh();
    await drainUntil(() => latestBattery()?.batteryPowerW === -1500);

    const observed = latestBattery();
    expect(observed?.batteryPowerW).toBe(-1500);
    expect(observed?.batterySoc).toBe(58);
  });

  // (c) READ-ONLY ISOLATION: a charging then discharging battery NEVER alters the
  // hard-cap / capacity view. The plan-rebuild totalKw + headroom track NET grid
  // import only, identical to a no-battery baseline.
  it('battery power never alters the capacity (hard-cap) view', async () => {
    const hourStartMs = Date.UTC(2026, 0, 15, 14, 0, 0);
    vi.setSystemTime(hourStartMs + SNAPSHOT_START_MINUTE * 60 * 1000);

    const battery = await buildBattery(62, 1200); // charging
    setMockDrivers({ driverA: new MockDriver('driverA', [await buildEv(), battery]) });
    seedSettings();
    driveHomeEnergy({ netW: TRUE_TOTAL_W });

    const app = createApp();
    spyLogs(app);
    await app.onInit();

    for (let i = 0; i < 6; i += 1) {
      await vi.advanceTimersByTimeAsync(POLL_MS);
      await flushDetached();
    }
    // The charging-side read is the FIRST cap view (post-init), so it cannot be a
    // stale pre-flip event — no plan-count guard needed here, only on the flip.
    await drainUntil(() => latestCapView()?.totalKw !== undefined && latestBattery()?.batterySoc === 62);

    const capWhileCharging = latestCapView();
    expect(capWhileCharging?.totalKw).toBeCloseTo(TRUE_TOTAL_W / 1000, 2); // 3.0 kW NET, not net+battery
    expect(capWhileCharging?.hardCapHeadroomKw).toBeCloseTo(CAP_KW - TRUE_TOTAL_W / 1000, 1); // 17.0

    // Flip to a strong discharge. Snapshot the plan-event count BEFORE the flip,
    // then await the battery being OBSERVED at -2500 W. The discharge must change
    // NOTHING the planner sees, so the cap view stays byte-identical to the
    // charging-side capture. (A non-managed battery legitimately triggers no plan
    // rebuild on its own, so we assert via the stable cap view + the invariant
    // that every plan event ever emitted shows the net 3.0 kW — never net+battery
    // — which can't pass vacuously: it inspects the whole event history.)
    await battery.setCapabilityValue('measure_power', -2500);
    await advanceAcrossSnapshotRefresh();
    await drainUntil(() => latestBattery()?.batteryPowerW === -2500);

    const capWhileDischarging = latestCapView();
    expect(capWhileDischarging?.totalKw).toBeCloseTo(TRUE_TOTAL_W / 1000, 2); // STILL 3.0 kW NET
    expect(capWhileDischarging?.hardCapHeadroomKw).toBeCloseTo(CAP_KW - TRUE_TOTAL_W / 1000, 1); // STILL 17.0
    // The cap view is unchanged across the entire charge->discharge swing.
    expect(capWhileDischarging?.totalKw).toBe(capWhileCharging?.totalKw);
    // And NO plan rebuild — at any point, charging or discharging — ever inflated
    // the capacity view by the battery power (would be 4.2 / 0.5 kW, not 3.0).
    expect(planEvents.length).toBeGreaterThan(0);
    for (const plan of planEvents) {
      expect(plan.totalKw).toBeCloseTo(TRUE_TOTAL_W / 1000, 2);
    }
  });

  // (d) Absence emits NOTHING: with no battery device present, no
  // battery_state_observed event is ever produced (no null-as-data event).
  it('emits no battery_state_observed event when no battery is present', async () => {
    const hourStartMs = Date.UTC(2026, 0, 15, 15, 0, 0);
    vi.setSystemTime(hourStartMs + 5 * 60 * 1000);

    // No battery device at all — only the EV.
    setMockDrivers({ driverA: new MockDriver('driverA', [await buildEv()]) });
    seedSettings();
    driveHomeEnergy({ netW: TRUE_TOTAL_W });

    const app = createApp();
    spyLogs(app);
    await app.onInit();

    for (let i = 0; i < 12; i += 1) {
      await vi.advanceTimersByTimeAsync(POLL_MS);
      await flushDetached();
    }
    // Let the snapshot/plan settle, then assert NO battery event was emitted.
    await drainUntil(() => latestCapView()?.totalKw !== undefined);
    expect(batteryEvents).toEqual([]);
  });

  // (e) Present -> removed: a battery is observed, then removed. After removal NO
  // further battery_state_observed event is emitted (no fake "cleared" event).
  it('emits nothing further once an observed battery is removed', async () => {
    const hourStartMs = Date.UTC(2026, 0, 15, 16, 0, 0);
    vi.setSystemTime(hourStartMs + SNAPSHOT_START_MINUTE * 60 * 1000);

    const battery = await buildBattery(62, 1200);
    const driver = new MockDriver('driverA', [await buildEv(), battery]);
    setMockDrivers({ driverA: driver });
    seedSettings();
    driveHomeEnergy({ netW: TRUE_TOTAL_W });

    const app = createApp();
    spyLogs(app);
    await app.onInit();

    await vi.advanceTimersByTimeAsync(POLL_MS);
    await flushDetached();
    await drainUntil(() => latestBattery()?.batterySoc === 62);

    // Remove the battery from the fetched device list.
    setMockDrivers({ driverA: new MockDriver('driverA', [await buildEv()]) });
    const countAfterPresent = batteryEvents.length;
    await advanceAcrossSnapshotRefresh();
    await drainUntil(() => latestCapView()?.totalKw !== undefined);

    // No battery event emitted after the removal (no retained value, no fake clear).
    expect(batteryEvents.length).toBe(countAfterPresent);
  });

  // (f) Present -> OFFLINE: Homey keeps an offline device in the list with RETAINED
  // (stale) caps. Once the battery goes available:false, no further battery event
  // is emitted — the stale offline reading must not be surfaced as fresh.
  it('emits nothing further once an observed battery goes offline (stale caps not surfaced)', async () => {
    const hourStartMs = Date.UTC(2026, 0, 15, 17, 0, 0);
    vi.setSystemTime(hourStartMs + SNAPSHOT_START_MINUTE * 60 * 1000);

    const battery = await buildBattery(62, 1200);
    setMockDrivers({ driverA: new MockDriver('driverA', [await buildEv(), battery]) });
    seedSettings();
    driveHomeEnergy({ netW: TRUE_TOTAL_W });

    const app = createApp();
    spyLogs(app);
    await app.onInit();

    await vi.advanceTimersByTimeAsync(POLL_MS);
    await flushDetached();
    await drainUntil(() => latestBattery()?.batterySoc === 62);

    // The battery goes offline but stays in the device list with its retained caps.
    battery.setAvailable(false);
    const countAfterPresent = batteryEvents.length;
    await advanceAcrossSnapshotRefresh();
    await drainUntil(() => latestCapView()?.totalKw !== undefined);

    // No battery event after it went offline — the stale 62%/1200 W is NOT re-emitted.
    expect(batteryEvents.length).toBe(countAfterPresent);
  });
});
