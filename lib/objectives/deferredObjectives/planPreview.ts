import type { DailyBudgetUiPayload } from '../../../packages/contracts/src/dailyBudgetTypes';
import type { DeferredObjectiveRescuePermissions } from '../../../packages/contracts/src/deferredObjectiveSettings';
import type { PowerTrackerState } from '../../power/tracker';
import type {
  DeferredObjectivePlanPreviewCandidate,
  DeferredObjectivePlanPreviewEstimate,
  DeferredObjectivePlanPreviewHour,
  DeferredObjectivePlanPreviewStatus,
  DeferredObjectivePlanPreviewUnavailableReason,
} from '../../../packages/contracts/src/deferredObjectivePlanPreview';
import { priceRateLabelToAmountUnit } from '../../../packages/shared-domain/src/price/priceUnitLabel';
import type { ObjectiveDeviceInput } from '../../objectives/types';
import { roundKWh } from './activePlanMath';
import { buildHoursFromHorizonPlan, resolveProjectedFinishAtMs } from './activePlanSchedule';
import {
  buildDeferredObjectiveDiagnostic,
  type BuildPriceHorizon,
  type DeferredObjectiveDiagnostic,
} from './diagnosticsBridge';
import {
  buildDeferredObjectivePolicyBucketPrices,
  buildDeferredObjectivePolicyWindowPrices,
} from './policyHorizon';
import type { DeferredObjectiveSettingsEntry } from './settings';

export type PreviewDeferredObjectivePlanParams = {
  nowMs: number;
  timeZone: string;
  deviceId: string;
  candidate: DeferredObjectivePlanPreviewCandidate;
  // The live plan-input device (already produced by `toPlanDevice`). Undefined
  // when the device is not in the current snapshot — the projection then comes
  // back `unavailable`, matching the planner's `objective_missing_device` path.
  device: ObjectiveDeviceInput | undefined;
  powerTracker: PowerTrackerState;
  dailyBudgetSnapshot: DailyBudgetUiPayload | null;
  // Price-layer allocation-horizon producer, injected by the wiring layer. The
  // daily-budget snapshot is the budget overlay only (and still feeds the
  // preview's price-curve / cost readers pending the preview migration).
  buildPriceHorizon: BuildPriceHorizon;
  priceOptimizationEnabled: boolean;
  hardCapKw: number | null;
  // The price-RATE label from the price store (e.g. "øre/kWh", "NOK",
  // "price units"). It is converted to a total-amount money unit before being
  // attached to the (total) `costEstimate`, so a UI never renders a total as a
  // per-kWh rate. Omit when unknown.
  priceRateLabel?: string;
};

/**
 * Instant, in-isolation estimate of the plan the planner WOULD produce for a
 * CANDIDATE deferred objective that is NOT persisted — ignores future re-plans
 * and competition with other objectives; not a guarantee.
 *
 * Fidelity comes from reuse, not re-implementation: this builds a diagnostic
 * through the exact `buildDeferredObjectiveDiagnostic` pipeline the live plan
 * cycle uses (`resolveObjectiveProgress` → `resolveProfileEnergy` →
 * `resolveObjectiveSteps` → `buildDeferredObjectivePolicyHorizon` →
 * `resolveHorizonPlanWithRescue`), then derives the schedule and finish with
 * the same `buildHoursFromHorizonPlan` / `resolveProjectedFinishAtMs` helpers
 * the active-plan recorder calls. The candidate carries no committed schedule
 * and is projected as a single task (no concurrent-eligible share), so the
 * estimate is the fresh-plan view.
 */
export const previewDeferredObjectivePlan = (
  params: PreviewDeferredObjectivePlanParams,
): DeferredObjectivePlanPreviewEstimate => {
  const diag = buildDeferredObjectiveDiagnostic({
    nowMs: params.nowMs,
    timeZone: params.timeZone,
    deviceId: params.deviceId,
    // The diagnostic pipeline reads an enabled `DeferredObjectiveSettingsEntry`;
    // a preview is implicitly enabled, so seed `enabled: true`.
    objective: withEnabled(params.candidate),
    device: params.device,
    powerTracker: params.powerTracker,
    dailyBudgetSnapshot: params.dailyBudgetSnapshot,
    buildPriceHorizon: params.buildPriceHorizon,
    priceOptimizationEnabled: params.priceOptimizationEnabled,
    // A candidate has no persisted active plan, so no committed hours bias the
    // allocation — this is deliberately the fresh-optimizer view.
    activePlans: null,
    hardCapKw: params.hardCapKw,
    // Omit concurrentEligibleCount: an in-isolation preview sees the full
    // single-task reserved-headroom share (the producer defaults to 1).
  });
  return buildEstimateFromDiagnostic({
    diag,
    dailyBudgetSnapshot: params.dailyBudgetSnapshot,
    priceRateLabel: params.priceRateLabel,
    nowMs: params.nowMs,
    deadlineAtMs: params.candidate.deadlineAtMs,
    powerTracker: params.powerTracker,
    hardCapKw: params.hardCapKw,
    // The candidate handed to this producer is ALREADY gated by the caller
    // (`App.gateCandidateExtraPermissions` runs before this), so its `rescue`
    // is the surviving permission set — reflect it onto the estimate verbatim.
    rescue: params.candidate.rescue,
  });
};

// Reflect the (already-gated) candidate rescue permissions onto a flat
// surviving-permissions shape for the estimate, so a summary UI renders only
// what the rescue would actually grant. Absent when the candidate carried no
// rescue permissions at all (older candidate / no opt-in) so the UI hides the
// block rather than claiming a permission the rescue won't grant.
const resolveGrantedRescuePermissions = (
  rescue: DeferredObjectiveRescuePermissions | undefined,
): { exemptFromBudget: boolean; limitLowerPriorityDevices: boolean } | undefined => {
  if (rescue === undefined) return undefined;
  return {
    exemptFromBudget: rescue.exemptFromBudget !== undefined,
    limitLowerPriorityDevices: rescue.limitLowerPriorityDevices !== undefined,
  };
};

const ONE_HOUR_MS = 60 * 60 * 1000;
// A measured-draw sample older than this is treated as too stale to make an
// at-cap claim against. PELS polls every ~10s (homey_energy) or on flow events;
// two minutes is generous enough to tolerate a flow gap while still refusing to
// assert "at cap right now" off a long-dead reading.
const AT_CAP_SAMPLE_FRESHNESS_MS = 2 * 60 * 1000;
// Fraction of the hard cap the measured draw must reach to count as "at cap".
// The preview is in-isolation optimistic about headroom; only flag when the
// house is genuinely pressed against the physical ceiling, not merely busy.
const AT_CAP_THRESHOLD = 0.98;

// Factual at-cap signal: is the candidate scheduled to run in the CURRENT clock
// hour while the measured whole-home draw is already at/above the physical hard
// cap? The in-isolation estimate is optimistic about headroom and cannot see the
// live cap pressure, so this corrects its "runs now" implication with a measured
// fact (draw vs cap), NEVER a suggestion to raise the cap (the cap is physical).
// Returns undefined when the inputs can't support the claim (no scheduled current
// hour, no/zero hard cap, or no fresh measured sample) so the UI omits the line
// rather than guessing.
const resolveAtCapNow = (params: {
  scheduledHours: DeferredObjectivePlanPreviewHour[];
  powerTracker: PowerTrackerState;
  hardCapKw: number | null;
  nowMs: number;
}): boolean | undefined => {
  const { scheduledHours, powerTracker, hardCapKw, nowMs } = params;
  if (typeof hardCapKw !== 'number' || !Number.isFinite(hardCapKw) || hardCapKw <= 0) return undefined;
  const currentHourStartMs = Math.floor(nowMs / ONE_HOUR_MS) * ONE_HOUR_MS;
  const runsCurrentHour = scheduledHours.some((hour) => hour.startsAtMs === currentHourStartMs);
  if (!runsCurrentHour) return undefined;
  const { lastPowerW, lastTimestamp } = powerTracker;
  if (typeof lastPowerW !== 'number' || !Number.isFinite(lastPowerW)) return undefined;
  if (typeof lastTimestamp !== 'number') return undefined;
  // Treat a negative age (clock drift / a future-dated timestamp) as not-fresh,
  // alongside the too-stale case — both fail the freshness contract, so neither
  // can support an at-cap claim.
  const ageMs = nowMs - lastTimestamp;
  if (ageMs < 0 || ageMs > AT_CAP_SAMPLE_FRESHNESS_MS) return undefined;
  return lastPowerW / 1000 >= hardCapKw * AT_CAP_THRESHOLD;
};

// Re-attach `enabled: true`, building each union member explicitly per `kind`.
// Constructing field-by-field (rather than spreading the candidate) keeps the
// result well-typed as `DeferredObjectiveSettingsEntry` without an `any`/`as`
// cast — a spread of the distributed-`Omit` candidate widens away the
// discriminant in TS's view. `rescue` is forwarded only when present so the
// optional stays absent rather than `undefined`.
const withEnabled = (
  candidate: DeferredObjectivePlanPreviewCandidate,
): DeferredObjectiveSettingsEntry => {
  if (candidate.kind === 'ev_soc') {
    return {
      enabled: true,
      kind: 'ev_soc',
      enforcement: candidate.enforcement,
      targetPercent: candidate.targetPercent,
      deadlineAtMs: candidate.deadlineAtMs,
      ...(candidate.rescue ? { rescue: candidate.rescue } : {}),
    };
  }
  return {
    enabled: true,
    kind: 'temperature',
    enforcement: 'soft',
    targetTemperatureC: candidate.targetTemperatureC,
    deadlineAtMs: candidate.deadlineAtMs,
    ...(candidate.rescue ? { rescue: candidate.rescue } : {}),
  };
};

// A thermal device with no usable energy profile yet — either no learned/bootstrap
// kWh-per-unit (`objective_missing_capacity`) or a learned rate but no executable
// step because `planningPowerKw` is uncalibrated (`objective_missing_charge_rate`).
// From the user's view both are the same "PELS hasn't observed this device draw
// power yet" cold-start, so they earn the same `needs_observation` copy. Mirrors
// `THERMAL_LEARNING_CAPACITY_REASON_CODES` in `activePlanRecorder`; the
// `temperature` guard keeps an EV's `objective_missing_charge_rate` (a real missing
// charger reading, not an observation gap) on the generic message.
const isThermalObservationGap = (diag: DeferredObjectiveDiagnostic): boolean => (
  diag.objectiveKind === 'temperature'
  && (diag.reasonCode === 'objective_missing_capacity'
    || diag.reasonCode === 'objective_missing_charge_rate')
);

const buildEstimateFromDiagnostic = (params: {
  diag: DeferredObjectiveDiagnostic;
  dailyBudgetSnapshot: DailyBudgetUiPayload | null;
  priceRateLabel: string | undefined;
  nowMs: number;
  deadlineAtMs: number;
  powerTracker: PowerTrackerState;
  hardCapKw: number | null;
  rescue: DeferredObjectiveRescuePermissions | undefined;
}): DeferredObjectivePlanPreviewEstimate => {
  const { diag, dailyBudgetSnapshot, priceRateLabel, nowMs, deadlineAtMs, powerTracker, hardCapKw, rescue } = params;
  const grantedRescuePermissions = resolveGrantedRescuePermissions(rescue);
  // No horizon plan attached → the planner could not project (missing prices,
  // missing device reading, price feature off, …). Surface `unavailable` with
  // null numerics rather than inventing a plan. When the cause is specifically a
  // thermal energy-profile gap (PELS hasn't observed this device draw power yet),
  // tag it so the UI can say "PELS must observe this device first" instead of
  // falsely blaming prices.
  if (!diag.horizonPlan) {
    return {
      status: 'unavailable',
      unavailableReason: resolvePreviewUnavailableReason(diag),
      scheduledHours: [],
      projectedFinishAtMs: null,
      energyEstimateKWh: null,
      energyExpectedKWh: null,
      costEstimate: null,
      ...(grantedRescuePermissions ? { grantedRescuePermissions } : {}),
    };
  }
  const scheduledHours: DeferredObjectivePlanPreviewHour[] = buildHoursFromHorizonPlan(diag) ?? [];
  const cost = resolveCostEstimate({ diag, dailyBudgetSnapshot });
  // `costEstimate` is a TOTAL amount (Σ kWh × price), so it must be labelled
  // with the money unit, never the per-kWh rate label `priceRateLabel` carries.
  const costUnit = priceRateLabel !== undefined
    ? priceRateLabelToAmountUnit(priceRateLabel)
    : undefined;
  // Hourly price curve across the now→deadline window for the preview chart.
  // Same snapshot prices the cost above is summed from, and epoch-hour-floored on
  // the same basis as `scheduledHours`, so the widget joins them by `startsAtMs`.
  const priceSeries = buildDeferredObjectivePolicyWindowPrices(dailyBudgetSnapshot, nowMs, deadlineAtMs)
    .map((point) => ({ startsAtMs: point.startMs, price: point.price }));
  const atCapNow = resolveAtCapNow({ scheduledHours, powerTracker, hardCapKw, nowMs });
  return {
    status: resolvePreviewStatus(diag.horizonPlan.status),
    scheduledHours,
    projectedFinishAtMs: resolveProjectedFinishAtMs(diag),
    // Match the recorder: persist the buffered `energyNeededKWh` rounded to
    // milliWh as the planned figure.
    energyEstimateKWh: roundKWh(diag.horizonPlan.energyNeededKWh),
    energyExpectedKWh: resolveEnergyExpectedKWh(diag),
    costEstimate: cost,
    ...(cost !== null && costUnit ? { costUnit } : {}),
    ...(priceSeries.length > 0 ? { priceSeries } : {}),
    ...(atCapNow !== undefined ? { atCapNow } : {}),
    ...(grantedRescuePermissions ? { grantedRescuePermissions } : {}),
  };
};

// `diag.status` is `'unknown' | DeferredObjectiveHorizonStatus`; the `unknown`
// case is handled before this is called (no horizonPlan), so the remaining
// values map 1:1 to the preview status union.
const resolvePreviewStatus = (
  status: NonNullable<DeferredObjectiveDiagnostic['horizonPlan']>['status'],
): DeferredObjectivePlanPreviewStatus => status;

const resolvePreviewUnavailableReason = (
  diag: DeferredObjectiveDiagnostic,
): DeferredObjectivePlanPreviewUnavailableReason => {
  if (isThermalObservationGap(diag)) return 'needs_observation';
  const reasonCode = diag.reasonCode;
  if (reasonCode === 'objective_invalid_deadline') return 'invalid_deadline';
  if (reasonCode === 'objective_invalid_session') return 'invalid_session';
  if (reasonCode === 'objective_charger_not_resumable') return 'not_resumable';
  if (reasonCode === 'objective_missing_capacity' || reasonCode === 'objective_missing_charge_rate') {
    return 'missing_capacity';
  }
  if (reasonCode === 'objective_missing_device') return 'missing_device';
  if (reasonCode === 'objective_missing_price_horizon') return 'missing_prices';
  if (reasonCode === 'objective_price_feature_disabled') return 'price_feature_disabled';
  if (reasonCode === 'objective_missing_temperature') return 'missing_reading';
  if (reasonCode === 'objective_progress_stale') return 'progress_stale';
  return 'unknown';
};

// Mirror the recorder's rule for `energyExpectedKWh`: surface it only when it
// is a finite number distinct from the buffered `energyNeededKWh`, so a UI's
// range collapses to one figure for steady/bootstrap/cold-start devices.
const resolveEnergyExpectedKWh = (diag: DeferredObjectiveDiagnostic): number | null => {
  const expected = diag.energyExpectedKWh;
  if (typeof expected !== 'number' || !Number.isFinite(expected)) return null;
  const rounded = roundKWh(expected);
  const planned = roundKWh((diag.horizonPlan as NonNullable<typeof diag.horizonPlan>).energyNeededKWh);
  return rounded === planned ? null : rounded;
};

// Cost = Σ(planned useful kWh × bucket price) over the planned buckets, using
// the same per-bucket price source the policy horizon consumed. Iterates the
// raw planned buckets (not the hour-collapsed schedule) so a bucket split at
// `planningEndMs` still prices against its own source bucket. Returns null when
// nothing is planned or no price is available for any planned bucket.
const resolveCostEstimate = (params: {
  diag: DeferredObjectiveDiagnostic;
  dailyBudgetSnapshot: DailyBudgetUiPayload | null;
}): number | null => {
  const horizonPlan = params.diag.horizonPlan;
  if (!horizonPlan) return null;
  const pricesByBucketId = buildDeferredObjectivePolicyBucketPrices(params.dailyBudgetSnapshot);
  if (pricesByBucketId.size === 0) return null;
  let cost = 0;
  let pricedAny = false;
  for (const bucket of horizonPlan.plannedBuckets) {
    if (bucket.plannedUsefulEnergyKWh <= 0) continue;
    const price = pricesByBucketId.get(bucket.sourceBucketId);
    if (typeof price !== 'number') continue;
    cost += bucket.plannedUsefulEnergyKWh * price;
    pricedAny = true;
  }
  if (!pricedAny) return null;
  // Round away float-accumulation noise. Cost is currency (kWh × price), not
  // energy, so it does not use `roundKWh`; 4 decimals is finer than any UI
  // would display and keeps the value stable across equivalent allocations.
  return Math.round(cost * COST_ROUNDING_FACTOR) / COST_ROUNDING_FACTOR;
};

const COST_ROUNDING_FACTOR = 10_000;
