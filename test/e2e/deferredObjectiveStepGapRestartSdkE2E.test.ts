// SDK-boundary regression for the 2026-08-01 prod incident: an app restart lost
// the water heater's flow-registered step ladder, `resolveObjectiveSteps` came up
// empty, and the COMMITTED smart task degraded to `unknown`
// (`objective_missing_charge_rate`) for 9.5 h — stripping its budget exemption
// (hero safe pace collapsed 2.2 → 1.3 kW in one cycle) while the committed plan
// sat untouched in persisted settings the whole time.
//
// THE RULE (lib/objectives/deferredObjectives/AGENTS.md): simulate ONLY the Homey
// SDK boundary — device readings, prices, the clock, and the persisted settings
// store (whose payload survives the restart) — and drive the REAL bridge +
// recorder + admission. No PELS internals are mocked.
//
// Expected behaviour under test: a committed task is served its frozen committed
// plan through a live step-ladder gap (protections hold, `expectedStepId`
// degrades to null, the cycle is marked `liveStepsUnavailable`), while a task
// with no commitment to serve still resolves `unknown`.
import { resolvedTrajectoryStatus } from '../../lib/objectives/deferredObjectives/diagnosticTypes';
import { describe, expect, it } from 'vitest';
import {
  normalizeDeferredObjectiveSettings,
  resolveDeferredObjectiveDeadline,
} from '../../lib/objectives/deferredObjectives';
import { buildDeferredObjectiveDiagnostics } from '../../lib/objectives/deferredObjectives/diagnosticsBridge';
import { buildPriceHorizonFromCombined } from '../../lib/price/priceStore';
import { applyDeferredObjectiveAdmission } from '../../lib/objectives/deferredObjectives/admission';
import { DeferredObjectiveActivePlanRecorder } from '../../lib/objectives/deferredObjectives/activePlanRecorder';
import type { DeferredObjectiveActivePlansV1 } from '../../packages/contracts/src/deferredObjectiveActivePlans';
import type { DeferredObjectiveDiagnostic } from '../../lib/objectives/deferredObjectives/diagnosticsBridge';
import type { DailyBudgetDayPayload, DailyBudgetUiPayload } from '../../lib/dailyBudget/dailyBudgetTypes';
import type { CombinedPriceEntry, CombinedPricesV2 } from '../../lib/price/priceTypes';
import type { PowerTrackerState } from '../../lib/power/tracker';
import { type PlanInputDevice, withBinaryDiscriminant } from '../../lib/plan/planTypes';

const HOUR_MS = 60 * 60 * 1000;
const MIN_MS = 60 * 1000;
const DAY = Date.UTC(2026, 0, 1, 0);
const DEVICE_ID = 'heater-1';
const TARGET_C = 63;
const START_C = 55; // 6.4 kWh needed — comfortably feasible, so the commitment is on_track
const RATE = 0.8; // kWh/°C, matches the power-tracker learned mean below
const FLOOR_KW = 1.25;
const ELEMENT_KW = 5;
const START_MS = DAY + 18 * HOUR_MS; // 18:00, task committed at bootstrap
const RESTART_MS = START_MS + 5 * MIN_MS; // 18:05, first cycle after the restart
const SETTLE_MS = START_MS + 58 * MIN_MS + 30 * 1000; // 18:58:30, replan-due cycle
const CHEAPEST = 50;
const CHEAP = 73.0;
const OUT_OF_HORIZON = 999;

// Flat cheap horizon with the CURRENT hour cheapest, so the bootstrap allocator
// deterministically books 18:00 (no price-deferral / cold-start release can idle
// it) and the post-restart admission decision is `planned`, not `idle`.
const todayPriceFor = (h: number): number => {
  if (h === 18) return CHEAPEST;
  return h >= 19 ? CHEAP : OUT_OF_HORIZON;
};
const todayPrices = Array.from({ length: 24 }, (_, h) => todayPriceFor(h));
const tomorrowPrices = Array.from({ length: 24 }, (_, h) => (h <= 5 ? CHEAP : OUT_OF_HORIZON));

// The step ladder is a live transport input (flow-registered overlay). Pre-restart
// the device carries it; post-restart it is gone and no calibrated/measured power
// stands in — exactly the prod shape that makes `resolveObjectiveSteps` return [].
const buildDevice = (tempC: number, nowMs: number, opts: { withSteps: boolean }): PlanInputDevice => withBinaryDiscriminant({ currentDrawKw: 0,
  id: DEVICE_ID,
  expectedPowerKw: 1, expectedPowerSource: 'default',
  name: 'Connected 300',
  commandableNow: true,
  targets: [{ id: 'target_temperature', value: TARGET_C, unit: 'C', min: 0, max: 95, step: 0.5 }],
  controlCapabilityId: 'onoff' as const,
  binaryControl: { on: false },
  controllable: false, // cap-off: the deferred objective is the only reason PELS drives it
  deviceType: 'temperature',
  controlModel: 'stepped_load',
  currentTemperature: tempC,
  lastFreshDataMs: nowMs,
  ...(opts.withSteps
    ? {
      steppedLoadProfile: {
        model: 'stepped_load',
        steps: [
          { id: 'off', planningPowerW: 0 },
          { id: 'low', planningPowerW: FLOOR_KW * 1000 },
          { id: 'max', planningPowerW: ELEMENT_KW * 1000 },
        ],
      },
    }
    : {}),
}) as PlanInputDevice;

// The learned kWh/°C rate is present and confident throughout — in prod it never
// degraded; only the step ladder did.
const buildPowerTracker = (nowMs: number): PowerTrackerState => ({
  objectiveProfiles: {
    [DEVICE_ID]: {
      kind: 'temperature',
      updatedAtMs: nowMs,
      lastSample: { observedAtMs: nowMs, value: START_C, unit: 'degree_c' },
      kwhPerUnit: { sampleCount: 8, mean: RATE, m2: 0, min: RATE, max: RATE, confidence: 'high', lastUpdatedMs: nowMs },
      acceptedSamples: 8,
      rejectedSamples: 0,
    },
  },
});

const buildDay = (dateKey: string, startMs: number, prices: number[], nowMs: number): DailyBudgetDayPayload => {
  const startUtc = Array.from({ length: 24 }, (_, i) => new Date(startMs + i * HOUR_MS).toISOString());
  return {
    dateKey,
    timeZone: 'UTC',
    nowUtc: new Date(nowMs).toISOString(),
    dayStartUtc: new Date(startMs).toISOString(),
    currentBucketIndex: Math.max(0, Math.min(23, Math.floor((nowMs - startMs) / HOUR_MS))),
    budget: { enabled: true, dailyBudgetKWh: 100, priceShapingEnabled: true },
    state: {
      usedNowKWh: 0, allowedNowKWh: 0, remainingKWh: 100, deviationKWh: 0,
      exceeded: false, frozen: false, confidence: 1, priceShapingActive: true,
    },
    buckets: {
      startUtc,
      startLocalLabels: startUtc.map((_, i) => `${String(i).padStart(2, '0')}:00`),
      plannedWeight: Array.from({ length: 24 }, () => 1 / 24),
      plannedKWh: Array.from({ length: 24 }, () => 1),
      plannedUncontrolledKWh: Array.from({ length: 24 }, () => 0),
      plannedControlledKWh: Array.from({ length: 24 }, () => 1),
      actualKWh: Array.from({ length: 24 }, () => 0),
      actualControlledKWh: Array.from({ length: 24 }, () => 0),
      actualUncontrolledKWh: Array.from({ length: 24 }, () => 0),
      allowedCumKWh: Array.from({ length: 24 }, (_, i) => (i + 1) * 4),
      price: prices,
      priceFactor: prices.map((p) => (p <= 10 ? 1.2 : 0.8)),
    },
  };
};

const buildSnapshot = (nowMs: number): DailyBudgetUiPayload => ({
  days: {
    '2026-01-01': buildDay('2026-01-01', DAY, todayPrices, nowMs),
    '2026-01-02': buildDay('2026-01-02', DAY + 24 * HOUR_MS, tomorrowPrices, nowMs),
  },
  todayKey: '2026-01-01',
  tomorrowKey: '2026-01-02',
});

const buildDayHours = (startMs: number, prices: number[]): CombinedPriceEntry[] => (
  prices.map((total, i) => ({
    startsAt: new Date(startMs + i * HOUR_MS).toISOString(),
    total,
    isCheap: total <= 10,
    isExpensive: false,
  }))
);
const buildCombinedPrices = (): CombinedPricesV2 => ({
  version: 2,
  days: {
    '2026-01-01': { hours: buildDayHours(DAY, todayPrices) },
    '2026-01-02': { hours: buildDayHours(DAY + 24 * HOUR_MS, tomorrowPrices) },
  },
  avgPrice: 0,
  lowThreshold: 0,
  highThreshold: 0,
  priceScheme: 'norway',
  priceUnit: 'øre/kWh',
});

const resolveDeadline = (): number => {
  const r = resolveDeferredObjectiveDeadline({ nowMs: START_MS, timeZone: 'UTC', deadlineLocalTime: '06:00' });
  if (r.deadlineAtMs === null) throw new Error('failed to resolve deadline');
  return r.deadlineAtMs;
};

// Exempt-from-budget is granted up front: the prod task ran with
// `rescueExemptMode: "always"`, and the exemption surviving the gap is the point.
const buildSettings = () => normalizeDeferredObjectiveSettings({
  version: 1,
  objectivesByDeviceId: {
    [DEVICE_ID]: {
      enabled: true,
      kind: 'temperature',
      enforcement: 'soft',
      targetTemperatureC: TARGET_C,
      deadlineAtMs: resolveDeadline(),
      rescue: { exemptFromBudget: 'always' },
    },
  },
});

const buildDiagnostic = (
  nowMs: number,
  device: PlanInputDevice,
  activePlans: DeferredObjectiveActivePlansV1 | null,
): DeferredObjectiveDiagnostic | undefined => buildDeferredObjectiveDiagnostics({
  nowMs,
  timeZone: 'UTC',
  devices: [device],
  settings: buildSettings(),
  powerTracker: buildPowerTracker(nowMs),
  dailyBudgetSnapshot: buildSnapshot(nowMs),
  buildPriceHorizon: (n, deadlineAtMs) => buildPriceHorizonFromCombined(buildCombinedPrices(), n, deadlineAtMs),
  priceOptimizationEnabled: true,
  activePlans,
})[0];

// Phase 1 (pre-restart): bootstrap-commit the plan with the step ladder present,
// and capture what the recorder persists to the settings store — the payload
// that survives the restart.
const commitPlanAndPersist = (): DeferredObjectiveActivePlansV1 => {
  let persisted: DeferredObjectiveActivePlansV1 | null = null;
  const recorder = new DeferredObjectiveActivePlanRecorder({
    load: () => null,
    save: (payload) => { persisted = payload; return true; },
  });
  const device = buildDevice(START_C, START_MS, { withSteps: true });
  const diag = buildDiagnostic(START_MS, device, recorder.getActivePlansSnapshot());
  expect(diag && resolvedTrajectoryStatus(diag)).toBe('on_track');
  recorder.observe(diag ? [diag] : [], START_MS);
  recorder.flushIfDirty();
  if (!persisted) throw new Error('bootstrap cycle did not persist a committed plan');
  return persisted;
};

describe('committed smart task vs a restart step-ladder gap (SDK-boundary e2e)', () => {
  const persisted = commitPlanAndPersist();

  // Restart: a NEW recorder loads the persisted payload (the settings store is
  // the only state that survives), and the device comes back without its
  // flow-registered step ladder.
  const restartedRecorder = () => new DeferredObjectiveActivePlanRecorder({
    load: () => persisted,
    save: () => true,
  });

  it('serves the frozen committed plan through the gap — protections hold', () => {
    const device = buildDevice(START_C, RESTART_MS, { withSteps: false });
    const diag = buildDiagnostic(RESTART_MS, device, restartedRecorder().getActivePlansSnapshot());

    expect(diag).toBeDefined();
    // The 2026-08-01 failure mode: status collapsed to `unknown`
    // (`objective_missing_charge_rate`) despite the persisted commitment.
    expect(diag && resolvedTrajectoryStatus(diag)).toBe('on_track');
    expect(diag?.liveStepsUnavailable).toBe(true);
    expect(diag?.horizonPlan?.currentBucket?.plannedUsefulEnergyKWh ?? 0).toBeGreaterThan(0);
    // No ladder ⇒ no step to expect; the executor drives the device via its
    // remaining controls (binary + temperature setpoint).
    expect(diag?.expectedStepId).toBeNull();

    const decision = applyDeferredObjectiveAdmission(diag ? [diag] : [], [device]).get(DEVICE_ID);
    expect(decision?.kind).toBe('planned');
    // The budget exemption — the protection whose loss collapsed the hero safe
    // pace 2.2 → 1.3 kW in prod — survives the gap.
    expect(decision && 'budgetExempt' in decision && decision.budgetExempt).toBe(true);
  });

  it('keeps serving frozen on a replan-due settle cycle (replan deferred, not the commitment dropped)', () => {
    const device = buildDevice(START_C, SETTLE_MS, { withSteps: false });
    const diag = buildDiagnostic(SETTLE_MS, device, restartedRecorder().getActivePlansSnapshot());

    // Past the `:58` settle mark the fresh allocator would normally run; without
    // steps it cannot, and the committed plan must still be served rather than
    // flapping to `unknown` for the settle window.
    expect(diag && resolvedTrajectoryStatus(diag)).toBe('on_track');
    expect(diag?.liveStepsUnavailable).toBe(true);
  });

  it('still resolves unknown when there is no commitment to serve', () => {
    const device = buildDevice(START_C, RESTART_MS, { withSteps: false });
    const freshRecorder = new DeferredObjectiveActivePlanRecorder({ load: () => null, save: () => true });
    const diag = buildDiagnostic(RESTART_MS, device, freshRecorder.getActivePlansSnapshot());

    expect(diag && resolvedTrajectoryStatus(diag)).toBeUndefined();
    expect(diag?.reasonCode).toBe('objective_missing_charge_rate');
    expect(diag?.liveStepsUnavailable).toBeUndefined();

    const decision = applyDeferredObjectiveAdmission(diag ? [diag] : [], [device]).get(DEVICE_ID);
    expect(decision?.kind).toBe('inactive');
    expect(decision?.budgetExempt).toBe(false);
  });

  it('the recorder survives the gap: frozen-shaped diagnostics at settles/rollovers leave the commitment intact', () => {
    // The one persisted-state combination this fix newly creates: the recorder's
    // `:58` settle observing a FROZEN-shaped diagnostic (pre-fix, a settle always
    // saw a fresh diagnostic or a no-horizon unknown). Drive the full recorder
    // loop across the gap — through the 18:58 settle and the 19:00 hour rollover —
    // and assert the persisted commitment envelope and its per-hour control
    // stamps (unit milestones, cheaperHourAhead) come out byte-identical.
    let reloaded: DeferredObjectiveActivePlansV1 | null = persisted;
    const recorder = new DeferredObjectiveActivePlanRecorder({
      load: () => persisted,
      save: (payload) => { reloaded = payload; return true; },
    });
    const stampsOf = (plans: DeferredObjectiveActivePlansV1 | null) => {
      const plan = plans?.plansByDeviceId[DEVICE_ID];
      return {
        commitment: plan?.commitment?.hours.map((h) => ({ startsAtMs: h.startsAtMs, plannedKWh: h.plannedKWh })),
        control: plan?.latest?.hours.map((h) => ({
          startsAtMs: h.startsAtMs,
          plannedKWh: h.plannedKWh,
          plannedUnitMilestone: h.plannedUnitMilestone,
          cheaperHourAhead: h.cheaperHourAhead,
        })),
      };
    };
    const before = stampsOf(persisted);
    const revisionBefore = persisted.plansByDeviceId[DEVICE_ID]?.latest?.revision;
    const lastCommittedHourEndMs = Math.max(
      ...(persisted.plansByDeviceId[DEVICE_ID]?.commitment?.hours.map((h) => h.startsAtMs) ?? [START_MS]),
    ) + HOUR_MS;
    // Cover at least the 18:58 settle and the 19:00 rollover, bounded by the
    // committed span (past its last hour the fallback legitimately ends).
    const gapEndMs = Math.min(lastCommittedHourEndMs, START_MS + 2 * HOUR_MS);
    expect(gapEndMs).toBeGreaterThan(START_MS + HOUR_MS);

    // A 5-minute grid from :05 lands on :55 then :00 and would sail past the
    // `:58` settle window — inject the settle marks explicitly so the recorder
    // genuinely observes a frozen-served diagnostic on a replan-due cycle.
    const settleMarks = [0, 1].map((h) => START_MS + h * HOUR_MS + 58 * MIN_MS + 30 * 1000);
    const cycleTimes = [
      ...Array.from(
        { length: Math.ceil((gapEndMs - RESTART_MS) / (5 * MIN_MS)) },
        (_, i) => RESTART_MS + i * 5 * MIN_MS,
      ),
      ...settleMarks,
    ].filter((t) => t < gapEndMs).sort((a, b) => a - b);
    expect(cycleTimes).toContain(settleMarks[0]);

    for (const nowMs of cycleTimes) {
      const device = buildDevice(START_C, nowMs, { withSteps: false });
      const diag = buildDiagnostic(nowMs, device, recorder.getActivePlansSnapshot());
      // Never `unknown` while the commitment covers the hour — including the
      // settle cycles, where the replan is deferred.
      expect(diag && resolvedTrajectoryStatus(diag)).toBe('on_track');
      expect(diag?.liveStepsUnavailable).toBe(true);
      recorder.observe(diag ? [diag] : [], nowMs);
      recorder.flushIfDirty();
    }

    // No settle write fired from the frozen-served diagnostics (the recorder's
    // `frozenRead` gate), so the persisted stamps are untouched — not merely
    // rewritten to equal values.
    expect(recorder.getActivePlansSnapshot().plansByDeviceId[DEVICE_ID]?.latest?.revision).toBe(revisionBefore);
    expect(stampsOf(reloaded)).toEqual(before);
  });
});
