/**
 * Pure plan/revision construction and replan-decision helpers for the
 * deferred-objective active-plan recorder. Split out of `activePlanRecorder.ts`
 * so that file stays the recorder class + persistence lifecycle; everything
 * here is a stateless transform over a diagnostic / persisted record (no
 * recorded-revision state, no I/O). `activePlanRecorder.ts` re-exports the two
 * public types below so importers keep their `./activePlanRecorder` path.
 *
 * Behaviour is identical to the previous in-file definitions — moved verbatim.
 */
import type {
  DeferredObjectiveActivePlanHourV1,
  DeferredObjectiveActivePlanPendingReason,
  DeferredObjectiveActivePlanRevisionReason,
  DeferredObjectiveActivePlanRevisionV1,
  DeferredObjectiveActivePlanV1,
  DeferredObjectiveActivePlansV1,
} from '../../../packages/contracts/src/deferredObjectiveActivePlans';
import {
  formatEstimatedDuration,
} from './activePlanDuration';
import { resolveDiagnosticReasonCode } from './activePlanDiagnosticReason';
import { resolveFloorShortfallCause } from './floorShortfallCause';
import {
  resolveHorizonPriceWatermark,
  resolvePersistedPricesUpTo,
} from './replanReason';
import type { StructuredDebugEmitter } from '../../logging/logger';
import type { DeferredObjectiveDiagnostic } from './diagnosticsBridge';
import type { DeferredObjectivePlanRevisionEvent } from './planRevisionBus';
import type { DeferredObjectiveRescuePermissions } from './settings';
import { resolveProjectedFinishAtMs } from './activePlanSchedule';
import { roundKWh } from './activePlanMath';
import { buildObjectiveSignature } from './activePlanSignature';

// Persisted plans store mixed objective kinds, so derive the nullable
// persisted value from the discriminated diagnostic.
export const diagTargetTemperatureC = (diag: DeferredObjectiveDiagnostic): number | null => (
  diag.objectiveKind === 'temperature' ? diag.targetTemperatureC : null
);

// The persisted `planStatus` is the status Flows read (deadlineObjectiveCards:
// "public Flow status follows the active-plan recorder's settled status"). It
// must follow the resolved user-facing `diagnostic.status` (idle-aware) so a
// parked/stalled device reports `satisfied` to Flows, agreeing with the status
// chip — NOT the raw `horizonPlan.status`, which stays the trajectory verdict
// that drives commitment/energy. They are identical except when
// `diagnosticsBridge` resolved a stalled device to `satisfied`. `diag.status`
// is never `unknown` here (callers only reach this with `horizonPlan` present),
// but narrow it to satisfy the non-`unknown` `planStatus` type.
export const reportedPlanStatus = (
  diag: DeferredObjectiveDiagnostic,
  horizonPlan: NonNullable<DeferredObjectiveDiagnostic['horizonPlan']>,
): DeferredObjectiveActivePlanRevisionV1['planStatus'] => (
  diag.status === 'unknown' ? horizonPlan.status : diag.status
);

export type ActivePlanPersistDeps = {
  load: () => DeferredObjectiveActivePlansV1 | null;
  save: (plans: DeferredObjectiveActivePlansV1) => void;
  debugStructured?: StructuredDebugEmitter;
  onRevisionWritten?: (event: DeferredObjectivePlanRevisionEvent) => void;
};

export type ActivePlanFlowCardSeed = {
  deviceId: string;
  deviceName: string | null;
  objectiveKind: 'temperature' | 'ev_soc';
  targetTemperatureC: number | null;
  targetPercent: number | null;
  deadlineAtMs: number;
  enforcement: 'soft' | 'hard';
  rescue?: DeferredObjectiveRescuePermissions;
};

export const notifyRevisionWrittenIfPubliclyObservable = (params: {
  deps: ActivePlanPersistDeps;
  diag: DeferredObjectiveDiagnostic;
  current: DeferredObjectiveActivePlanV1;
  latest: DeferredObjectiveActivePlanRevisionV1;
  revision: DeferredObjectiveActivePlanRevisionV1;
  reason: DeferredObjectiveActivePlanRevisionReason;
  allocationChanged: boolean;
}): void => {
  const planStatusChanged = params.latest.planStatus !== params.revision.planStatus;
  if (!params.allocationChanged && !planStatusChanged) return;
  params.deps.onRevisionWritten?.({
    eventType: 'revision_written',
    deviceId: params.diag.deviceId,
    deviceName: params.diag.deviceName ?? params.current.deviceName,
    objectiveKind: params.diag.objectiveKind,
    revision: params.revision,
    reason: params.reason,
    previousPlanStatus: params.latest.planStatus,
    previousWasPending: false,
    allocationChanged: params.allocationChanged,
    projectedFinishAtMs: resolveProjectedFinishAtMs(params.diag),
  });
};

// Byte-equality of the persisted in-flight hour anchor so `applyInProgressAnchors`
// can skip marking the active plans dirty when nothing moved (a steady run holds
// the same opening until the hour rolls over).
export const sameHourOpening = (
  a: { hourMs: number; value: number } | undefined,
  b: { hourMs: number; value: number } | undefined,
): boolean => {
  if (a === undefined || b === undefined) return a === b;
  return a.hourMs === b.hourMs && a.value === b.value;
};

// Carry forward the persisted in-flight postmortem anchors from a prior plan
// record (same run) onto a freshly-built one, omitting absent fields so the
// byte-shape stays stable for plans that never had an anchor.
export const carryInFlightAnchors = (
  previous: DeferredObjectiveActivePlanV1 | undefined,
): Pick<DeferredObjectiveActivePlanV1, 'inFlightHourOpening' | 'inFlightKWhPerUnit'> => ({
  ...(previous?.inFlightHourOpening !== undefined
    ? { inFlightHourOpening: previous.inFlightHourOpening }
    : {}),
  ...(previous?.inFlightKWhPerUnit !== undefined
    ? { inFlightKWhPerUnit: previous.inFlightKWhPerUnit }
    : {}),
});

export const buildSignatureFromDiagnostic = (diag: DeferredObjectiveDiagnostic): string | null => {
  if (diag.deadlineAtMs === null) return null;
  return buildObjectiveSignature({
    objectiveKind: diag.objectiveKind,
    targetTemperatureC: diagTargetTemperatureC(diag),
    targetPercent: diag.targetPercent,
    deadlineAtMs: diag.deadlineAtMs,
    enforcement: diag.enforcement,
    rescue: diag.rescue,
  });
};

export const createPlanFromSeed = (seed: ActivePlanFlowCardSeed, nowMs: number): DeferredObjectiveActivePlanV1 => ({
  deviceId: seed.deviceId,
  deviceName: seed.deviceName,
  objectiveKind: seed.objectiveKind,
  targetTemperatureC: seed.targetTemperatureC,
  targetPercent: seed.targetPercent,
  deadlineAtMs: seed.deadlineAtMs,
  startedAtMs: nowMs,
  pending: true,
  objectiveSignature: buildObjectiveSignature({
    objectiveKind: seed.objectiveKind,
    targetTemperatureC: seed.targetTemperatureC,
    targetPercent: seed.targetPercent,
    deadlineAtMs: seed.deadlineAtMs,
    enforcement: seed.enforcement,
    rescue: seed.rescue,
  }),
  original: null,
  latest: null,
});

// Reason codes from `diagnosticsBridge` that indicate the device-data side of the diagnostic
// failed before a horizon plan could be built. The pending hero needs to say "waiting for a
// reading from the device", not "waiting for prices" — see the comment in `ensurePendingRecord`.
const DEVICE_DATA_REASON_CODES: ReadonlySet<string> = new Set([
  'objective_invalid_deadline',
  'objective_missing_charge_rate',
  'objective_missing_device',
  'objective_missing_temperature',
  'objective_progress_stale',
]);

// For thermal objectives, `objective_missing_charge_rate` means the planner has the kWh/°C
// (learned or bootstrap) but no executable step yet — typically because `planningPowerKw`
// has not been calibrated from observed power. That is the same "still learning the energy
// profile" state as `objective_missing_capacity`, and the "Learning energy use" hero copy
// describes it correctly. EVs keep the generic `device_data_missing` mapping because for
// them `objective_missing_charge_rate` really is a missing reading from the charger.
const THERMAL_LEARNING_CAPACITY_REASON_CODES: ReadonlySet<string> = new Set([
  'objective_missing_capacity',
  'objective_missing_charge_rate',
]);

export const resolvePendingReason = (
  diag: DeferredObjectiveDiagnostic,
): DeferredObjectiveActivePlanPendingReason => {
  if (diag.reasonCode === 'objective_price_feature_disabled') return 'price_feature_disabled';
  // EV plugged-out / discharging session — surface a dedicated "paused —
  // unplugged" copy variant so the user knows the plan resumes once they
  // plug back in. Without this the hero said the generic "Waiting" with no
  // hint that the action is on the user, not PELS.
  if (diag.reasonCode === 'objective_invalid_session') return 'invalid_session';
  // EV connected but PELS can't resume the charger — surface a dedicated
  // "can't resume" copy variant so a not-resumable charger that has no plan yet
  // (pending from the start) gets the same honest hero as the list chip,
  // instead of falling through to the generic "Waiting for tomorrow's prices".
  if (diag.reasonCode === 'objective_charger_not_resumable') return 'charger_not_resumable';
  // Thermal devices have no shipped bootstrap kWh/°C; tell the user that
  // power readings are what unblock the plan instead of leaving them with an
  // indefinite "Waiting" state. For thermal objectives this also covers
  // `objective_missing_charge_rate` (no executable step yet because
  // `planningPowerKw` is uncalibrated), which is the same cold-start state
  // from the user's point of view.
  if (
    diag.objectiveKind === 'temperature'
      && THERMAL_LEARNING_CAPACITY_REASON_CODES.has(diag.reasonCode)
  ) {
    return 'missing_capacity';
  }
  if (DEVICE_DATA_REASON_CODES.has(diag.reasonCode)) return 'device_data_missing';
  return 'awaiting_horizon_plan';
};

export const createPlanFromDiagnostic = (
  diag: DeferredObjectiveDiagnostic,
  signature: string,
  nowMs: number,
): DeferredObjectiveActivePlanV1 => {
  const diagnosticReasonCode = resolveDiagnosticReasonCode(diag);
  return {
    deviceId: diag.deviceId,
    deviceName: diag.deviceName ?? null,
    objectiveKind: diag.objectiveKind,
    targetTemperatureC: diagTargetTemperatureC(diag),
    targetPercent: diag.targetPercent,
    deadlineAtMs: diag.deadlineAtMs as number,
    startedAtMs: nowMs,
    pending: true,
    pendingReason: resolvePendingReason(diag),
    ...(diagnosticReasonCode !== undefined ? { diagnosticReasonCode } : {}),
    objectiveSignature: signature,
    original: null,
    latest: null,
  };
};

// Producer-resolved display rate (kWh per °C / %) for the plan-inputs row.
// Collapses the bootstrap-vs-learned branching the settings UI used to do
// (`resolveKwhPerUnitDisplayRate`): the diagnostic carries the same value the
// UI displayed — the learned profile mean for `learned`, or the EV bootstrap
// constant for `bootstrap` — on `kWhPerUnitBanded`. `null` when the resolver
// short-circuited (no source) or the value isn't a usable positive number.
const resolveRateMean = (diag: DeferredObjectiveDiagnostic): number | null => {
  if (diag.kwhPerUnitSource === null) return null;
  const rate = diag.kWhPerUnitBanded;
  return typeof rate === 'number' && Number.isFinite(rate) && rate > 0 ? rate : null;
};

// Producer-resolved presentation-speed mode. `bootstrap` source (EV cold-start,
// no learned profile yet) maps to `learning`; everything else is `auto`. The
// settings UI keeps the enum->human-string map ("Auto" / "Learning…") per
// `feedback_ui_text_shared_with_logs`; the recorder persists only the enum.
const resolveSpeedMode = (
  source: NonNullable<DeferredObjectiveDiagnostic['kwhPerUnitSource']>,
): 'auto' | 'learning' => (source === 'bootstrap' ? 'learning' : 'auto');

export const buildRevision = (params: {
  diag: DeferredObjectiveDiagnostic;
  hours: DeferredObjectiveActivePlanHourV1[];
  revision: number;
  reason: DeferredObjectiveActivePlanRevisionReason;
  nowMs: number;
  // The prior revision's price-availability watermark, carried forward when this
  // diagnostic stamped none (a frozen mid-hour read or a transient prices-missing
  // cycle that still wrote a revision). Resetting it to `null` would blind the
  // NEXT fresh revision's advance check (`previous === null ⇒ not an advance`)
  // and re-mislabel a genuine Nordpool publish as `schedule_revised`. Undefined
  // for the first revision (no prior watermark to preserve).
  previousPricesUpTo?: number | null;
}): DeferredObjectiveActivePlanRevisionV1 => {
  // Callers only invoke buildRevision after `buildHoursFromHorizonPlan` returned
  // non-null, which guarantees `horizonPlan` is present.
  const horizonPlan = params.diag.horizonPlan as NonNullable<typeof params.diag.horizonPlan>;
  // Persist `kwhPerUnitSource` only when the diagnostic actually consulted a
  // profile (or its bootstrap fallback). `null` means the resolver short-
  // circuited (e.g. target already met) — omit the field rather than write
  // a misleading value.
  const source = params.diag.kwhPerUnitSource;
  // Producer-resolved flat display rate (kWh/°C or kWh/%). Suppressed (left
  // null) when the resolver short-circuited or the value isn't usable; see
  // `resolveRateMean`.
  const rateMean = resolveRateMean(params.diag);
  // Only persist `dailyBudgetExhaustedBucketCount` when non-zero so older
  // persisted plans without the field stay byte-stable across revisions and
  // consumers that haven't been updated keep falling back to zero.
  const exhaustedBuckets = params.diag.dailyBudgetExhaustedBucketCount;
  // Producer-resolved floor-shortfall verdict. Suppress `none` so steady
  // on-track plans stay byte-stable; `budget` covers the squeeze case
  // (`dailyBudgetExhaustedBucketCount: 0` but the per-bucket cap still binds)
  // — see the contract type for the full mapping.
  const floorShortfallCause = resolveFloorShortfallCause(params.diag.reasonCode);
  const energyNeededKWh = roundKWh(horizonPlan.energyNeededKWh);
  // Mean-based expected energy, rounded to match `energyNeededKWh`. Persisted
  // only when it differs from the buffered figure, so steady devices stay
  // byte-stable across revisions and the UI's range collapses to one number.
  const energyExpectedKWhRaw = params.diag.energyExpectedKWh;
  const energyExpectedKWh = typeof energyExpectedKWhRaw === 'number' ? roundKWh(energyExpectedKWhRaw) : null;
  const planningSpeedKw = params.diag.planningSpeedKw;
  // Estimated duration is a derived field — the recorder is the right place
  // to format it so the hero meta line and any downstream consumer (flow
  // tokens) agree on the rounding/unit conventions.
  const estimatedDurationText = formatEstimatedDuration(energyNeededKWh, planningSpeedKw);
  return {
    revision: params.revision,
    revisedAtMs: params.nowMs,
    computedFromPricesUpTo: resolvePersistedPricesUpTo(
      resolveHorizonPriceWatermark(params.diag),
      params.previousPricesUpTo,
    ),
    reason: params.reason,
    hours: params.hours,
    // Round to milliWh to match `plannedKWh`. Without rounding,
    // floating-point accumulation in the kWh/unit-band integrator (or the
    // simple multiply on the unbanded path) can produce ~1e-15 kWh drift
    // that would appear in persisted output even when the underlying
    // allocation is byte-identical.
    energyNeededKWh,
    ...(energyExpectedKWh !== null && energyExpectedKWh !== energyNeededKWh
      ? { energyExpectedKWh }
      : {}),
    planStatus: reportedPlanStatus(params.diag, horizonPlan),
    ...(source !== null ? { kwhPerUnitSource: source } : {}),
    // Producer-resolved flat display fields (see `resolveRateMean` /
    // `resolveSpeedMode`). Gated on `source !== null` alongside
    // `kwhPerUnitSource` so revisions where the resolver short-circuited
    // (target already met) stay byte-stable and the UI keeps falling back to
    // the live learned-profile mean. `rateMean` is further suppressed when it
    // didn't resolve to a usable positive number so we don't persist a
    // misleading `null`.
    ...(source !== null ? { speedMode: resolveSpeedMode(source) } : {}),
    ...(rateMean !== null ? { rateMean } : {}),
    ...(exhaustedBuckets > 0 ? { dailyBudgetExhaustedBucketCount: exhaustedBuckets } : {}),
    ...(floorShortfallCause !== 'none' ? { floorShortfallCause } : {}),
    ...(typeof planningSpeedKw === 'number' && planningSpeedKw > 0 ? { planningSpeedKw } : {}),
    ...(estimatedDurationText !== null ? { estimatedDurationText } : {}),
  };
};

// Per-plan provenance is best-effort and only written when at least one
// field has useful content; otherwise older consumers continue using the
// fall-back lookup against the live profile store.
export const resolveProvenance = (
  diag: DeferredObjectiveDiagnostic,
): DeferredObjectiveActivePlanV1['kwhPerUnitProvenance'] | undefined => {
  const source = diag.kwhPerUnitSource;
  if (source === null) return undefined;
  const learnedKwh = source === 'learned' ? diag.kWhPerUnitBanded : null;
  const confidence = source === 'learned' && isProvenanceConfidence(diag.rateConfidence)
    ? diag.rateConfidence
    : null;
  const displayConfidence = source === 'learned' && isProvenanceConfidence(diag.displayConfidence)
    ? diag.displayConfidence
    : null;
  return {
    source,
    kWhPerUnit: typeof learnedKwh === 'number' && Number.isFinite(learnedKwh) ? learnedKwh : null,
    acceptedSamples: source === 'learned' ? diag.kwhPerUnitAcceptedSamples : 0,
    confidence,
    displayConfidence,
    lastAcceptedAtMs: source === 'learned' ? diag.kwhPerUnitLastAcceptedAtMs : null,
  };
};

const isProvenanceConfidence = (
  value: string | null,
): value is 'low' | 'medium' | 'high' => (
  value === 'low' || value === 'medium' || value === 'high'
);

// Caller already established `sameHourSchedule(latest.hours, hours)`. Returns
// true when consumer-visible status fields drifted across the same set of
// charging hours. Tracked fields and the UI signal each drives:
//   - `planStatus`                       → "Can't fully meet" chip
//   - `dailyBudgetExhaustedBucketCount`  → per-bucket headroom explanation
//   - `floorShortfallCause`              → hero recourse routing
//     (budget-bound → `Open Budget`, otherwise device-side). Squeeze-case
//     repro: `at_risk` stays put while cause flips from `feasible_above_floor`
//     to `limited_by_daily_budget` as background load shifts the per-bucket
//     cap binding; without re-persisting, the recourse would stay device-side.
// Legacy fields absent on `latest` resolve to `none`/`0` so unchanged revisions
// don't thrash on the first cycle after upgrade. Per-cycle drift in
// `plannedKWh` / `energyNeededKWh` is intentionally NOT a persist trigger —
// an actively charging EV shrinks `energyNeededKWh` monotonically every cycle.
export const hasMetadataDriftedWithinSchedule = (params: {
  latest: DeferredObjectiveActivePlanRevisionV1;
  horizonPlan: NonNullable<DeferredObjectiveDiagnostic['horizonPlan']>;
  diag: DeferredObjectiveDiagnostic;
}): boolean => {
  const { latest, horizonPlan, diag } = params;
  return latest.planStatus !== reportedPlanStatus(diag, horizonPlan)
    || (latest.dailyBudgetExhaustedBucketCount ?? 0) !== diag.dailyBudgetExhaustedBucketCount
    || (latest.floorShortfallCause ?? 'none') !== resolveFloorShortfallCause(diag.reasonCode);
};

export const resolveSourceTransition = (params: {
  latest: DeferredObjectiveActivePlanRevisionV1;
  diag: DeferredObjectiveDiagnostic;
}): { sourceChanged: boolean; sourceRefined: boolean } => {
  // Treat absence on `latest` as `learned` so legacy persisted revisions don't
  // appear to transition on the first observation after upgrade.
  const previousSource = params.latest.kwhPerUnitSource ?? 'learned';
  const nextSource = params.diag.kwhPerUnitSource;
  return {
    sourceChanged: nextSource !== null && previousSource !== nextSource,
    sourceRefined: previousSource === 'bootstrap' && nextSource === 'learned',
  };
};

// Relative drift in the learned per-unit energy rate (kWh/°C or kWh/%) above
// which the committed plan's energy assumption is treated as materially stale.
// 15% balances "honest enough to tell the user the plan's energy basis shifted"
// against "don't churn history on profile-learning jitter".
const MEASURED_DEVIATION_RELATIVE_THRESHOLD = 0.15;

// The live learned per-unit energy rate, or null when the diagnostic is still
// on the bootstrap fallback or the resolver short-circuited (target met). This
// is the SAME quantity `resolveProvenance` freezes, so the baseline and the
// live reading compare like with like. It is deliberately NOT instantaneous
// power: a thermostat at temperature or mid-duty-cycle reads ~0 W, but the
// learned rate is accumulated over progress, so an idle cycle contributes no
// sample and the last learned rate stands — no false "delivery collapsed"
// reading.
export const resolveLearnedRateKwh = (diag: DeferredObjectiveDiagnostic): number | null => {
  if (diag.kwhPerUnitSource !== 'learned') return null;
  // Use the sample-driven global mean, NOT `kWhPerUnitBanded`:
  // those are the banded average over the remaining interval and shift as the
  // task crosses bands even with no new samples, which would fire spurious
  // deviations during normal progress. The global mean only moves on real
  // rate drift. See `diagnosticsBridge.kwhPerUnitLearnedMean`.
  const rate = diag.kwhPerUnitLearnedMean;
  return typeof rate === 'number' && Number.isFinite(rate) && rate > 0 ? rate : null;
};

// True when the live learned energy rate has drifted past the threshold from
// the rate the committed plan was built against (`current.initialKwhPerUnit`).
// Both sides must be a learned rate — that single gate is what keeps thermostat
// live-power swings, EV nameplate cold-starts, and bootstrap estimates from
// ever reaching here. An objective change owns its own stronger reason and
// invalidates the cross-objective comparison, so it suppresses this.
export const hasLearnedRateDeviated = (params: {
  current: DeferredObjectiveActivePlanV1;
  diag: DeferredObjectiveDiagnostic;
  objectiveChanged: boolean;
}): boolean => {
  if (params.objectiveChanged) return false;
  const live = resolveLearnedRateKwh(params.diag);
  const baseline = params.current.initialKwhPerUnit;
  if (live === null || typeof baseline !== 'number' || !Number.isFinite(baseline) || baseline <= 0) {
    return false;
  }
  return Math.abs(live - baseline) / baseline >= MEASURED_DEVIATION_RELATIVE_THRESHOLD;
};

// The committed learned-rate baseline carried onto the next revision. Frozen
// when the rate first becomes learned, reset on objective change, and
// re-baselined to the live rate whenever a measured_deviation fires — so a
// sustained drift reports once and gradual drift re-arms after each report.
// Depends only on `current.initialKwhPerUnit` and the live diagnostic, never on
// the previous revision's per-cycle snapshot, so an unrelated null-rate or
// below-threshold revision can neither corrupt the baseline nor break the
// debounce.
export const resolveInitialKwhPerUnit = (params: {
  current: DeferredObjectiveActivePlanV1;
  diag: DeferredObjectiveDiagnostic;
  objectiveChanged: boolean;
  measuredDeviation: boolean;
}): number | undefined => {
  const live = resolveLearnedRateKwh(params.diag) ?? undefined;
  if (params.objectiveChanged || params.measuredDeviation) return live;
  return params.current.initialKwhPerUnit ?? live;
};

// Spreadable persisted fragment for the committed learned-rate baseline:
// carries the key only when defined, so the `objective_changed`/bootstrap
// "no baseline" path drops it cleanly. Kept as a helper so the conditional
// stays out of `maybeWriteReplanRevision`'s complexity budget.
export const toInitialKwhPerUnitField = (
  value: number | undefined,
): { initialKwhPerUnit?: number } => (
  value !== undefined ? { initialKwhPerUnit: value } : {}
);

export const shouldWriteReplanRevision = (params: {
  objectiveChanged: boolean;
  scheduleChanged: boolean;
  metadataDriftedWithinSchedule: boolean;
  sourceChanged: boolean;
  measuredDeviation: boolean;
}): boolean => (
  params.objectiveChanged || params.scheduleChanged
    || params.metadataDriftedWithinSchedule || params.sourceChanged
    || params.measuredDeviation
);

// Bounded most-recent-first log of past revisions kept on the active plan
// record so the smart-task detail page can render a revision-history panel
// without re-fetching anything. Each replan prepends the previous `latest`
// onto the array and slices to this cap (FIFO prune). 20 covers any
// realistic smart-task lifecycle — schedule-changing replans are typically
// single-digit per task.
//
// Worst-case size per device: ~48-bucket horizon × 20 revisions × ~50 B JSON
// per bucket ≈ 48 KB of buckets, plus per-revision metadata (~1 KB total)
// pushes the upper bound to ~60 KB. Even with ten chatty devices that's 600 KB
// against the 30 MB Homey RSS headroom (`project_homey_rss_limit`); the cap
// is comfortable, not tight.
export const MAX_HISTORY_REVISIONS = 20;

// `objectiveChanged` discards the previous commitment entirely and seeds a
// fresh one from the live `hours`. `scheduleChanged` (e.g. phase-2
// expansion grew the commitment) advances `committedAtMs` and persists the
// merged `effectiveHours`. Otherwise the existing commitment is preserved
// so within-schedule metadata drift doesn't visibly reshape the timestamp.
export const resolveCommitment = (params: {
  objectiveChanged: boolean;
  scheduleChanged: boolean;
  effectiveHours: DeferredObjectiveActivePlanHourV1[];
  previous: DeferredObjectiveActivePlanV1['commitment'];
  nowMs: number;
}): DeferredObjectiveActivePlanV1['commitment'] => {
  // `effectiveHours` carries the stamped unit milestones (for objectiveChanged it
  // is the freshly-stamped live hours; for scheduleChanged the stamped merge), so
  // the persisted commitment matches `latest.hours` exactly.
  if (params.objectiveChanged || params.scheduleChanged) {
    return { committedAtMs: params.nowMs, hours: params.effectiveHours };
  }
  return params.previous;
};
