// SDK-boundary e2e for the MANAGED vs UNMANAGED (controlled vs uncontrolled) load
// split WHILE SOLAR IS PRODUCING.
//
// WHAT THIS PROBES: PELS measures the two halves of the split on different bases.
//   - MANAGED load  = the gross sum of each managed device's own `measure_power`
//                     (metered at the appliance; an EV pulling 2 kW reads 2 kW
//                     whether that 2 kW comes from the grid or the panels).
//   - WHOLE-HOME total = the Homey Energy `manager/energy/live` `cumulative.W`,
//                     which on a P1/HAN net meter is NET grid power — already
//                     reduced by self-consumed solar, negative on export.
//   Without a gross-up, unmanaged is the residual total(net) − managed(gross),
//   bounded to [0, total], so the moment net falls below the summed managed draw
//   the split corrupts: managed clamps DOWN to net, unmanaged collapses to 0.
//
// THE FIX UNDER TEST: PELS derives one authoritative whole-home ACTUAL
// CONSUMPTION = net grid import + gross generation (`totalGenerated.W` from the
// same payload), and bounds the split against THAT. The hard-cap import path and
// the billed-kWh total bucket keep the net `cumulative.W` ("split by purpose").
//
// HOW PV IS SIMULATED: through its real signals in the Homey Energy report — a
// reduced `cumulative.W` (net) plus a `totalGenerated.W` (production). No internal
// mock. Observation is the SDK seam (driven report, driven device meters) and the
// state PELS writes back through settings (`power_tracker_state`).
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
import type { PowerTrackerState } from '../../lib/power/trackerTypes';

const POLL_MS = 10_000;

// One managed EV drawing a steady 2.0 kW at the appliance meter, plus 1.0 kW of
// implicit background (the gap between the driven whole-home total and the EV draw).
const EV_DRAW_W = 2000;
const BACKGROUND_W = 1000;
const TRUE_TOTAL_W = EV_DRAW_W + BACKGROUND_W; // 3.0 kW of real household consumption
const SOLAR_W = 2500; // panels producing 2.5 kW -> net = 3.0 - 2.5 = 0.5 kW (self-consume, no export)

// A cap far above any net total here so capacity shedding never fires and the EV
// keeps drawing its full 2.0 kW throughout — we are testing accounting, not control.
const CAP_KW = 20;

type PlanRebuildEvent = { event?: string; totalKw?: number; hardCapHeadroomKw?: number };

// Drive `manager/energy/live` with a fixed net watt value and optional gross
// generation (the PV signal path). Returns a setter so a test can flip state.
const driveHomeEnergy = (initial: { netW: number; generationW?: number }) => {
  let state = initial;
  const originalGet = mockHomeyInstance.api.get.bind(mockHomeyInstance.api);
  vi.spyOn(mockHomeyInstance.api, 'get').mockImplementation(async (path: string) => {
    if (path === 'manager/energy/live') {
      const report: { items: unknown[]; totalGenerated?: { W: number } } = {
        items: [{ type: 'cumulative', values: { W: state.netW } }],
      };
      if (typeof state.generationW === 'number') {
        report.totalGenerated = { W: state.generationW };
        report.items.push({ type: 'generator', values: { W: state.generationW } });
      }
      return report;
    }
    return originalGet(path);
  });
  return (next: { netW: number; generationW?: number }) => { state = next; };
};

const flushDetached = async (rounds = 12): Promise<void> => {
  for (let i = 0; i < rounds; i += 1) {
    await vi.advanceTimersByTimeAsync(0);
    await new Promise<void>((resolve) => { process.nextTick(resolve); });
  }
};

const buildEv = async (): Promise<MockDevice> => {
  const ev = new MockDevice('ev', 'EV charger', ['onoff', 'measure_power', 'meter_power'], 'socket');
  await ev.setCapabilityValue('onoff', true);
  await ev.setCapabilityValue('measure_power', EV_DRAW_W);
  return ev;
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

type Split = { controlledW: number; uncontrolledW: number; netW: number; controlledKWh: number; uncontrolledKWh: number };

const readSplit = (bucketKey: string): Split => {
  const tracker = mockHomeyInstance.settings.get('power_tracker_state') as PowerTrackerState | null;
  return {
    controlledW: tracker?.lastControlledPowerW ?? Number.NaN,
    uncontrolledW: tracker?.lastUncontrolledPowerW ?? Number.NaN,
    netW: tracker?.lastPowerW ?? Number.NaN,
    controlledKWh: tracker?.controlledBuckets?.[bucketKey] ?? 0,
    uncontrolledKWh: tracker?.uncontrolledBuckets?.[bucketKey] ?? 0,
  };
};

describe('Managed vs unmanaged split while solar produces (SDK-boundary e2e)', () => {
  let planEvents: PlanRebuildEvent[];

  const spyPlanLogs = (app: { log: (...args: unknown[]) => void }): void => {
    const origLog = app.log.bind(app);
    // eslint-disable-next-line no-param-reassign -- intentional test log spy
    app.log = (...args: unknown[]) => {
      for (const arg of args) {
        if (typeof arg !== 'string') continue;
        try {
          const parsed = JSON.parse(arg) as PlanRebuildEvent;
          if (parsed.event === 'plan_rebuild_completed') planEvents.push(parsed);
        } catch { /* non-JSON log line */ }
      }
      return origLog(...args);
    };
  };
  const latestCapView = (): PlanRebuildEvent | undefined =>
    [...planEvents].reverse().find((e) => typeof e.totalKw === 'number');

  beforeEach(() => {
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

  // BASELINE: no sun. Proves the harness and the split are sound when net == gross.
  it('without solar, records managed ~2.0 kW and unmanaged ~1.0 kW (net == gross)', async () => {
    const hourStartMs = Date.UTC(2026, 0, 15, 12, 0, 0);
    vi.setSystemTime(hourStartMs + 5 * 60 * 1000);
    const bucketKey = new Date(hourStartMs).toISOString();

    setMockDrivers({ driverA: new MockDriver('driverA', [await buildEv()]) });
    seedSettings();
    driveHomeEnergy({ netW: TRUE_TOTAL_W }); // 3.0 kW net, no solar

    const app = createApp();
    spyPlanLogs(app);
    await app.onInit();

    for (let i = 0; i < 12; i += 1) {
      await vi.advanceTimersByTimeAsync(POLL_MS);
      await flushDetached();
    }
    await drainUntil(() => Number.isFinite(readSplit(bucketKey).controlledW));

    const split = readSplit(bucketKey);

    expect(split.controlledW).toBeCloseTo(EV_DRAW_W, -1); // ~2000 W
    expect(split.uncontrolledW).toBeCloseTo(BACKGROUND_W, -1); // ~1000 W
    expect(split.controlledKWh).toBeGreaterThan(0);
    expect(split.uncontrolledKWh).toBeGreaterThan(0);
  });

  // UNDER SELF-CONSUMPTION: panels offset 2.5 kW so net = 0.5 kW < the 2.0 kW EV draw.
  // The fix grosses up actual consumption (net + generation = 3.0 kW) for the split,
  // so the EV's true 2.0 kW and the 1.0 kW background are both recovered — while the
  // cap/import path still sees the 0.5 kW net.
  it('under solar self-consumption, the split reflects true device draws AND the cap stays on net import', async () => {
    const hourStartMs = Date.UTC(2026, 0, 15, 13, 0, 0);
    vi.setSystemTime(hourStartMs + 5 * 60 * 1000);
    const bucketKey = new Date(hourStartMs).toISOString();

    setMockDrivers({ driverA: new MockDriver('driverA', [await buildEv()]) });
    seedSettings();
    driveHomeEnergy({ netW: TRUE_TOTAL_W - SOLAR_W, generationW: SOLAR_W }); // net 0.5 kW, gen 2.5 kW

    const app = createApp();
    spyPlanLogs(app);
    await app.onInit();

    for (let i = 0; i < 12; i += 1) {
      await vi.advanceTimersByTimeAsync(POLL_MS);
      await flushDetached();
    }
    await drainUntil(() => Number.isFinite(readSplit(bucketKey).controlledW));

    const split = readSplit(bucketKey);
    const capView = latestCapView();

    // (1) The split attribution is correct: gross consumption = 0.5 + 2.5 = 3.0 kW.
    expect(split.controlledW).toBeCloseTo(EV_DRAW_W, -1); // managed ~2000 W
    expect(split.uncontrolledW).toBeCloseTo(BACKGROUND_W, -1); // background ~1000 W
    expect(split.controlledKWh).toBeGreaterThan(0);
    expect(split.uncontrolledKWh).toBeGreaterThan(0);

    // (2) Cap/import isolation: the stored net (for the total bucket) and the cap's
    // view of whole-home power stay on the 0.5 kW NET import — gross never leaks in.
    expect(split.netW).toBeCloseTo(TRUE_TOTAL_W - SOLAR_W, -1); // ~500 W
    expect(capView?.totalKw).toBeCloseTo((TRUE_TOTAL_W - SOLAR_W) / 1000, 2); // 0.5 kW, NOT 3.0
    expect(capView?.hardCapHeadroomKw).toBeCloseTo(CAP_KW - (TRUE_TOTAL_W - SOLAR_W) / 1000, 1); // 19.5
  });
});
