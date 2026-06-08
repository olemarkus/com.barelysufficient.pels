// SDK-boundary e2e (createApp): a smart task's limit-lower-priority "boost"
// permission lets a priority-1 stepped device escalate PAST the shed invariant —
// but ONLY in the task's planned hours. With NO daily budget, the hourly capacity
// hard cap is the only per-hour constraint.
//
// THE RULE THIS TEST FOLLOWS (notes/testing-taxonomy.md): nothing internal is
// mocked, the scenario is driven ONLY at the Homey SDK boundary, and the decision
// is OBSERVED ONLY through structured logs. The whole app boots through
// `createApp().onInit()`; power, prices, the device's observed temperature/step,
// the clock, and the persisted learned-rate datum are simulated at the SDK seam
// (the energy poll, the `combined_prices` setting, the mock device's capabilities,
// `vi.setSystemTime`, the `power_tracker_state` setting); the plan cycle is driven
// by advancing the timers (the real 10 s energy poll + the periodic rebuild), NOT
// by reaching into `planService`. The real snapshot parser (`parseDevice`), the
// real planner, the real deferred bridge + admission, and the real executor all
// run. The restore lane's own structured events at the Homey logging seam
// (`restore_stepped_admitted` / `restore_stepped_rejected`) are the observable —
// never a plan-snapshot read. This mirrors the canonical deferred SDK harness
// (test/e2e/deferredObjectiveColdStartSdkE2E.test.ts).
//
// Scenario (the counterintuitive shed invariant from docs/technical.md): a
// priority-1 stepped tank with capacity control ON and NO device-level boost
// config, drawing at its low step. A lower-priority device is held shed (its
// restore power dwarfs any hourly headroom), so the shed invariant normally pins
// the tank at its low step even though it is drawing enough to want the next step
// up (`restore_stepped_rejected`, `rejectionReason: 'shed_invariant'`). A smart
// task with `rescue.limitLowerPriorityDevices:'always'` (paired, as the create gate
// requires, with `exemptFromBudget:'always'`) forces boost on in its planned hours,
// so the escalation is admitted instead (`restore_stepped_admitted`,
// `blockedByShedInvariant: false`). The ONLY lever between the two task cases is the
// price curve (which hour the planner books).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MockDevice, MockDriver, mockHomeyInstance, setMockDrivers } from '../mocks/homey';
import { cleanupApps, createApp } from '../utils/appTestUtils';
import { drainUntil } from '../utils/asyncDrain';
import {
  CAPACITY_DRY_RUN, CAPACITY_LIMIT_KW, CAPACITY_MARGIN_KW,
  COMBINED_PRICES, CONTROLLABLE_DEVICES, DAILY_BUDGET_ENABLED,
  DEBUG_LOGGING_TOPICS, DEVICE_TARGET_POWER_CONFIGS, MANAGED_DEVICES,
} from '../../lib/utils/settingsKeys';

const HOUR_MS = 60 * 60 * 1000;
// Midnight UTC so the price day-key and the clock stay aligned without offset math.
const DAY = Date.UTC(2026, 4, 10, 0, 0, 0);
const TODAY_KEY = new Date(DAY).toISOString().slice(0, 10);
const TANK = 'tank';
const LOWER = 'lower';

const TARGET_C = 53;
const KWH_PER_DEGREE = 1.5;
// Below target so the smart task is still active, but far enough along that it has
// schedule slack — letting the planner RELEASE an expensive current hour toward a
// cheaper later one. The device still draws at its low step, so the restore lane
// still WANTS to escalate it (the shed invariant is the thing under test).
const CURRENT_C = 52.8;
const STEP_LOW_W = 1500;
// A lower-priority restore demand far above any dynamic hourly headroom (PELS's
// capacity model is energy-based: early in the hour the soft limit can briefly
// exceed the nominal kW cap), so the device stays shed every cycle and the shed
// invariant always applies.
const LOWER_LOAD_W = 8000;
const CAPACITY_LIMIT = 3.0;
const ESCALATED_STEP = '2000w'; // one step above the low step the recent draw requests

// A 24-hour price curve with a single, distinctly cheap hour. `cheapHour` is the
// only hour the planner prefers; every other hour is dear.
const buildPrices = (cheapHour: number): number[] => (
  Array.from({ length: 24 }, (_, h) => (h === cheapHour ? 5 : 50))
);

const buildCombinedPrices = (cheapHour: number) => ({
  version: 2,
  days: {
    [TODAY_KEY]: {
      hours: buildPrices(cheapHour).map((total, i) => ({
        startsAt: new Date(DAY + i * HOUR_MS).toISOString(),
        total,
        isCheap: false,
        isExpensive: false,
      })),
    },
  },
  avgPrice: 0,
  lowThreshold: 0,
  highThreshold: 0,
  priceScheme: 'norway',
  priceUnit: 'øre/kWh',
});

// The persisted learned-rate datum the app restores on init (temperature
// objectives have no bootstrap rate, so this is what lets the task plan at all).
const buildPowerTracker = (nowMs: number) => ({
  lastTimestamp: nowMs,
  objectiveProfiles: {
    [TANK]: {
      kind: 'temperature' as const,
      updatedAtMs: DAY,
      lastSample: { observedAtMs: DAY, value: CURRENT_C, unit: 'degree_c' as const },
      kwhPerUnit: {
        sampleCount: 50, mean: KWH_PER_DEGREE, m2: 0, min: KWH_PER_DEGREE, max: KWH_PER_DEGREE,
        confidence: 'high' as const, lastUpdatedMs: DAY,
      },
      acceptedSamples: 50,
      rejectedSamples: 0,
    },
  },
});

const baseTask = {
  enabled: true,
  kind: 'temperature' as const,
  enforcement: 'soft' as const,
  targetTemperatureC: TARGET_C,
  deadlineAtMs: DAY + 6 * HOUR_MS,
};
// A boost task: limit-lower-priority is the boost permission, and the create gate
// only persists it alongside exempt-from-budget, so a faithful task carries both.
const BOOST_TASK = {
  ...baseTask,
  rescue: { limitLowerPriorityDevices: 'always' as const, exemptFromBudget: 'always' as const },
};
// A plain task: NO standing permissions (the common case — "heat to 53 °C by 06:00").
// Not budget-exempt, so its allocation is subject to the daily-budget overlay.
const PLAIN_TASK = baseTask;

type SmartTask = false | 'boost' | 'plain';

// A restore-lane structured event for the stepped device, as it lands at the Homey
// logging seam.
type SteppedEvent = {
  event?: string;
  deviceId?: string;
  requestedStepId?: string;
  toStepId?: string;
  rejectionReason?: string;
  blockedByShedInvariant?: boolean;
};
// The deferred-objective horizon diagnostic, observed at the same seam.
type DeferredDiag = {
  status?: string;
  reasonCode?: string;
  plannedUsefulEnergyKWh?: number;
  // The step the task scheduled the device to RUN at this hour. A real (non-`off`)
  // step only when the current bucket is a planned (admitted) bucket; `null`/absent
  // when the hour is released or the task is `cannot_meet`.
  expectedStepId?: string | null;
  limitLowerPriorityApplied?: boolean;
  budgetExemptApplied?: boolean;
};

type Observed = {
  steppedEvents: SteppedEvent[];
  diag: DeferredDiag | undefined;
};

const runCycleAtHour = async (params: {
  cheapHour: number;
  currentHour: number;
  withSmartTask: SmartTask;
  dailyBudgetEnabled?: boolean;
}): Promise<Observed> => {
  const { cheapHour, currentHour, withSmartTask, dailyBudgetEnabled = false } = params;
  // Mid-hour tick — the live power cycle always sees the current bucket clipped to
  // `now`, never landing on the :58 settle mark.
  vi.setSystemTime(new Date(DAY + currentHour * HOUR_MS + 30 * 60 * 1000));

  mockHomeyInstance.settings.set(DEBUG_LOGGING_TOPICS, ['plan', 'diagnostics', 'deferred_objectives']);
  mockHomeyInstance.settings.set('power_source', 'homey_energy');
  mockHomeyInstance.settings.set(CAPACITY_LIMIT_KW, CAPACITY_LIMIT);
  mockHomeyInstance.settings.set(CAPACITY_MARGIN_KW, 0);
  mockHomeyInstance.settings.set(CAPACITY_DRY_RUN, false);
  // No daily budget: the hourly capacity hard cap is the only per-hour constraint.
  mockHomeyInstance.settings.set(DAILY_BUDGET_ENABLED, dailyBudgetEnabled);
  // The deferred-objective allocation horizon is a price-optimization feature.
  mockHomeyInstance.settings.set('price_optimization_enabled', true);
  mockHomeyInstance.settings.set(MANAGED_DEVICES, { [TANK]: true, [LOWER]: true });
  mockHomeyInstance.settings.set(CONTROLLABLE_DEVICES, { [TANK]: true, [LOWER]: true });
  mockHomeyInstance.settings.set('capacity_priorities', { Home: { [TANK]: 1, [LOWER]: 5 } });
  // Defined stepped load via the target-power config: off/500…3000 W in 500 W steps.
  mockHomeyInstance.settings.set(DEVICE_TARGET_POWER_CONFIGS, { [TANK]: { enabled: true, min: 0, max: 3000, step: 500 } });
  mockHomeyInstance.settings.set(COMBINED_PRICES, buildCombinedPrices(cheapHour));
  mockHomeyInstance.settings.set('power_tracker_state', buildPowerTracker(DAY + currentHour * HOUR_MS));
  if (withSmartTask === 'boost') {
    mockHomeyInstance.settings.set(`deferred_objective.${TANK}`, BOOST_TASK);
  } else if (withSmartTask === 'plain') {
    mockHomeyInstance.settings.set(`deferred_objective.${TANK}`, PLAIN_TASK);
  }

  const tank = new MockDevice(TANK, 'Tank',
    ['measure_power', 'target_temperature', 'measure_temperature', 'onoff', 'target_power'], 'heater');
  await tank.setCapabilityValue('measure_power', STEP_LOW_W);
  await tank.setCapabilityValue('measure_temperature', CURRENT_C);
  await tank.setCapabilityValue('target_temperature', TARGET_C);
  await tank.setCapabilityValue('onoff', true);
  await tank.setCapabilityValue('target_power', STEP_LOW_W); // observed at step '1500w'
  const lower = new MockDevice(LOWER, 'Lower', ['onoff', 'measure_power'], 'heater');
  await lower.setCapabilityValue('onoff', false);
  await lower.setCapabilityValue('measure_power', 0);
  lower.setSettings({ load: LOWER_LOAD_W });
  setMockDrivers({ d: new MockDriver('d', [tank, lower]) });

  // Drive total home power through the real Homey Energy poll (the SDK seam).
  const originalGet = mockHomeyInstance.api.get.bind(mockHomeyInstance.api);
  vi.spyOn(mockHomeyInstance.api, 'get').mockImplementation(async (path: string) => {
    if (path === 'manager/energy/live') return { items: [{ type: 'cumulative', values: { W: STEP_LOW_W } }] };
    return originalGet(path);
  });

  const app = createApp();
  // Observe ONLY through structured logs: they land at the Homey logging seam
  // (`app.log`) as JSON (level/pid/hostname stripped by the Homey destination).
  // Spy BEFORE `onInit` so the first warm-up cycle's events are captured too — the
  // restore lane emits its decision once per state change, not every cycle.
  const steppedEvents: SteppedEvent[] = [];
  const diagEvents: DeferredDiag[] = [];
  const origLog = app.log.bind(app);
  app.log = (...args: unknown[]) => {
    for (const arg of args) {
      if (typeof arg !== 'string') continue;
      try {
        const parsed = JSON.parse(arg) as { event?: string; deviceId?: string } & SteppedEvent & DeferredDiag;
        if (typeof parsed.event === 'string' && parsed.event.startsWith('restore_stepped_') && parsed.deviceId === TANK) {
          steppedEvents.push(parsed);
        } else if (parsed.event === 'deferred_objective_horizon_planned') {
          diagEvents.push(parsed);
        }
      } catch { /* non-JSON log line */ }
    }
    return origLog(...args);
  };
  await app.onInit();
  // Drive the real plan cycle off the SDK clock: the 10 s energy poll plus the
  // periodic rebuild. No internal `rebuildPlanFromCache` kick.
  for (let i = 0; i < 10; i++) {
    await vi.advanceTimersByTimeAsync(10_000);
    await drainUntil(() => false, { rounds: 20 }).catch(() => {});
  }

  return { steppedEvents, diag: diagEvents.at(-1) };
};

const findEvent = (events: SteppedEvent[], name: string): SteppedEvent | undefined => (
  events.find((e) => e.event === name)
);

describe('smart-task boost — no daily budget, hourly hard cap (SDK-boundary e2e via createApp)', () => {
  beforeEach(() => {
    // 'Date' MUST be faked: the price store prunes its day window relative to the
    // app clock, so without a faked clock the simulated prices fall outside the
    // window and the allocation horizon is empty.
    vi.useFakeTimers({
      toFake: ['setTimeout', 'setInterval', 'setImmediate', 'clearTimeout', 'clearInterval', 'clearImmediate', 'Date'],
    });
    mockHomeyInstance.settings.removeAllListeners();
    mockHomeyInstance.settings.clear();
    mockHomeyInstance.flow._actionCardListeners = {};
    mockHomeyInstance.flow._conditionCardListeners = {};
    mockHomeyInstance.flow._triggerCardRunListeners = {};
    mockHomeyInstance.flow._triggerCardTriggers = {};
  });
  afterEach(async () => {
    await cleanupApps();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('WITHOUT a smart task: the shed invariant rejects the tank step-up', async () => {
    // No task, current hour is the cheap one (so price can never be blamed): the
    // tank draws at its low step and the restore lane wants to escalate it, but a
    // lower-priority device is shed, so the shed invariant rejects the step-up.
    const { steppedEvents } = await runCycleAtHour({ cheapHour: 0, currentHour: 0, withSmartTask: false });

    const rejected = findEvent(steppedEvents, 'restore_stepped_rejected');
    expect(rejected).toMatchObject({
      requestedStepId: ESCALATED_STEP,
      rejectionReason: 'shed_invariant',
      blockedByShedInvariant: true,
    });
    expect(findEvent(steppedEvents, 'restore_stepped_admitted')).toBeUndefined();
  });

  it('WITH a boost smart task in a PLANNED (cheap) hour: boost admits the step-up past the shed invariant', async () => {
    // Current hour is the planned (cheap) hour: the task books it, engages boost,
    // and the restore lane ADMITS the escalation (1500 -> 2000 W) DESPITE the
    // lower-priority device still being shed — the shed invariant did NOT block it.
    const { steppedEvents } = await runCycleAtHour({ cheapHour: 0, currentHour: 0, withSmartTask: 'boost' });

    const admitted = findEvent(steppedEvents, 'restore_stepped_admitted');
    expect(admitted).toMatchObject({
      toStepId: ESCALATED_STEP,
      blockedByShedInvariant: false,
    });
    // ...and the shed invariant never rejected the tank this run.
    expect(steppedEvents.some((e) => e.event === 'restore_stepped_rejected' && e.blockedByShedInvariant === true))
      .toBe(false);
  });

  it('WITH the same boost smart task in a RELEASED (expensive) hour: no boost — the shed invariant rejects the step-up', async () => {
    // ONLY the price curve changes: the cheap hour is now LATER (hour 2), so the
    // planner releases the expensive current hour (hour 0) toward it. The task is
    // not in a planned hour, boost stays off, and the shed invariant rejects the
    // step-up again — proving boost is scoped to the task's planned hours.
    const { steppedEvents } = await runCycleAtHour({ cheapHour: 2, currentHour: 0, withSmartTask: 'boost' });

    const rejected = findEvent(steppedEvents, 'restore_stepped_rejected');
    expect(rejected).toMatchObject({
      requestedStepId: ESCALATED_STEP,
      rejectionReason: 'shed_invariant',
      blockedByShedInvariant: true,
    });
    expect(findEvent(steppedEvents, 'restore_stepped_admitted')).toBeUndefined();
  });

  it('A PLAIN (exempt-OFF) smart task is admitted to run against the hard cap when daily budget is OFF', async () => {
    // Regression guard for the disabled-daily-budget zero-cap seam (exempt-from-budget
    // OFF + daily budget OFF): the snapshot still carries an all-zero `allowedCumKWh`,
    // which the policy-horizon overlay used to read as a per-bucket budget of 0 —
    // clamping a non-exempt task to zero useful energy (`cannot_meet`, never runs,
    // `expectedStepId: null`). A disabled budget must contribute NO cap, so a plain
    // task books real energy and is ADMITTED to run the device, bounded only by the
    // per-hour hard cap.
    const { diag, steppedEvents } = await runCycleAtHour({ cheapHour: 0, currentHour: 0, withSmartTask: 'plain' });

    // Admitted end-to-end: a plannable status (NOT cannot_meet), real booked energy,
    // and the current hour scheduled to a real RUNNING step (`expectedStepId`) — the
    // task is actively running the device this hour, not idled by a phantom 0 budget.
    expect(diag?.status).not.toBe('cannot_meet');
    expect(diag?.reasonCode).not.toBe('deadline_passed');
    expect(diag?.plannedUsefulEnergyKWh).toBeGreaterThan(0);
    expect(diag?.expectedStepId).toBeTruthy();
    expect(diag?.expectedStepId).not.toBe('off');
    // A plain task carries no budget exemption and no boost permission.
    expect(diag?.budgetExemptApplied).toBe(false);
    expect(diag?.limitLowerPriorityApplied).toBeFalsy();
    // ...and without the boost permission it cannot bypass the shed invariant: the
    // step-up is still rejected while the lower-priority device is shed.
    expect(findEvent(steppedEvents, 'restore_stepped_rejected')).toMatchObject({
      rejectionReason: 'shed_invariant',
      blockedByShedInvariant: true,
    });
    expect(findEvent(steppedEvents, 'restore_stepped_admitted')).toBeUndefined();
  });
});
