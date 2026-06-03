/* eslint-disable max-lines -- active-plan recorder, diagnostics, and replay stay together. */
import type {
  DeferredObjectiveActivePlanDiagnosticReason,
  DeferredObjectiveActivePlanHourV1,
  DeferredObjectiveActivePlanPendingReason,
  DeferredObjectiveActivePlanRevisionReason,
  DeferredObjectiveActivePlanRevisionV1,
  DeferredObjectiveActivePlanV1,
  DeferredObjectiveActivePlansV1,
} from '../../../packages/contracts/src/deferredObjectiveActivePlans';
import {
  formatEstimatedDuration,
  resolvePlanLevelDurationSnapshot,
  toPersistedPlanLevelDurationFields,
} from './activePlanDuration';
import { DEFERRED_OBJECTIVE_ACTIVE_PLANS_VERSION } from './activePlanSettings';
import { resolveFloorShortfallCause } from './floorShortfallCause';
import {
  hasPriceHorizonAdvanced,
  resolveHorizonPriceWatermark,
  resolveReplanReason,
} from './replanReason';
import { getLogger } from '../../logging/logger';
import type { StructuredDebugEmitter } from '../../logging/logger';
import { buildActivePlanLifecycleFields } from './activePlanLifecycleFields';
import type { DeferredObjectiveDiagnostic } from './diagnosticsBridge';
import type { DeferredObjectivePlanRevisionEvent } from './planRevisionBus';
import type { DeferredObjectiveRescuePermissions } from './settings';
import {
  buildHoursFromHorizonPlan,
  mergeHoursPreservingCommitment,
  resolveProjectedFinishAtMs,
  sameHourSchedule,
  shouldFireNotification,
  stampCheaperHourAhead,
  stampUnitMilestones,
} from './activePlanSchedule';
import { roundKWh } from './activePlanMath';
import { buildObjectiveSignature, compareObjectiveSignatures } from './activePlanSignature';

const logger = getLogger('plan/deferred-active');

// Persisted plans store mixed objective kinds, so derive the nullable
// persisted value from the discriminated diagnostic.
const diagTargetTemperatureC = (diag: DeferredObjectiveDiagnostic): number | null => (
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
const reportedPlanStatus = (
  diag: DeferredObjectiveDiagnostic,
  horizonPlan: NonNullable<DeferredObjectiveDiagnostic['horizonPlan']>,
): DeferredObjectiveActivePlanRevisionV1['planStatus'] => (
  diag.status === 'unknown' ? horizonPlan.status : diag.status
);


// Mirror `planHistory.ts` ABANDON_GRACE_MS. Homey settings reads can transiently
// return empty/malformed data; if a plan cycle ever produces an empty
// diagnostic stream we must not drop persisted plans on the first miss. Wait
// at least an hour without seeing the diagnostic before declaring the
// objective abandoned.
const ABANDON_GRACE_MS = 60 * 60 * 1000;

const ONE_HOUR_MS = 60 * 60 * 1000;

// Replan revisions settle once per clock hour, near the end (the `:58` mark), not
// on every plan cycle. By `:58` the elapsed hour's outcome is known and the
// upcoming hour can be scheduled in; settling earlier would churn the persisted
// record on the current hour's capacity trimming (the device may still climb to
// deliver before the hour ends — "we don't know until the end of the hour"). The
// planner's per-cycle live allocation is unaffected (it still reacts every cycle,
// e.g. `expandCommittedAllocation`'s current-hour fill); only the RECORD waits.
// A user objective edit (`objectiveChanged`) is an external event and revises
// immediately. See notes/deferred-load-objectives/execution-adaptation.md.
const SCHEDULE_SETTLE_OFFSET_MS = 58 * 60 * 1000;

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

const notifyRevisionWrittenIfPubliclyObservable = (params: {
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

const buildSignatureFromDiagnostic = (diag: DeferredObjectiveDiagnostic): string | null => {
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

const createPlanFromSeed = (seed: ActivePlanFlowCardSeed, nowMs: number): DeferredObjectiveActivePlanV1 => ({
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

const resolvePendingReason = (
  diag: DeferredObjectiveDiagnostic,
): DeferredObjectiveActivePlanPendingReason => {
  if (diag.reasonCode === 'objective_price_feature_disabled') return 'price_feature_disabled';
  // EV plugged-out / discharging session — surface a dedicated "paused —
  // unplugged" copy variant so the user knows the plan resumes once they
  // plug back in. Without this the hero said the generic "Waiting" with no
  // hint that the action is on the user, not PELS.
  if (diag.reasonCode === 'objective_invalid_session') return 'invalid_session';
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

// Narrow diagnostic reason codes that the UI needs to render specific copy
// (e.g. "car unplugged") beyond what `pendingReason` alone can express.
const resolveDiagnosticReasonCode = (
  diag: DeferredObjectiveDiagnostic,
): DeferredObjectiveActivePlanDiagnosticReason | undefined => (
  diag.reasonCode === 'objective_invalid_session' ? 'objective_invalid_session' : undefined
);

const createPlanFromDiagnostic = (
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
// constant for `bootstrap` — on `kWhPerPercent` (EV) / `kWhPerDegreeC`
// (thermal). `null` when the resolver short-circuited (no source) or the value
// isn't a usable positive number.
const resolveRateMean = (diag: DeferredObjectiveDiagnostic): number | null => {
  if (diag.kwhPerUnitSource === null) return null;
  const rate = diag.kWhPerPercent ?? diag.kWhPerDegreeC;
  return typeof rate === 'number' && Number.isFinite(rate) && rate > 0 ? rate : null;
};

// Producer-resolved presentation-speed mode. `bootstrap` source (EV cold-start,
// no learned profile yet) maps to `learning`; everything else is `auto`. The
// settings UI keeps the enum->human-string map ("Auto" / "Learning…") per
// `feedback_ui_text_shared_with_logs`; the recorder persists only the enum.
const resolveSpeedMode = (
  source: NonNullable<DeferredObjectiveDiagnostic['kwhPerUnitSource']>,
): 'auto' | 'learning' => (source === 'bootstrap' ? 'learning' : 'auto');

const buildRevision = (params: {
  diag: DeferredObjectiveDiagnostic;
  hours: DeferredObjectiveActivePlanHourV1[];
  revision: number;
  reason: DeferredObjectiveActivePlanRevisionReason;
  nowMs: number;
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
    computedFromPricesUpTo: resolveHorizonPriceWatermark(params.diag),
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
const resolveProvenance = (
  diag: DeferredObjectiveDiagnostic,
): DeferredObjectiveActivePlanV1['kwhPerUnitProvenance'] | undefined => {
  const source = diag.kwhPerUnitSource;
  if (source === null) return undefined;
  const learnedKwh = source === 'learned' ? (diag.kWhPerPercent ?? diag.kWhPerDegreeC) : null;
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
const hasMetadataDriftedWithinSchedule = (params: {
  latest: DeferredObjectiveActivePlanRevisionV1;
  horizonPlan: NonNullable<DeferredObjectiveDiagnostic['horizonPlan']>;
  diag: DeferredObjectiveDiagnostic;
}): boolean => {
  const { latest, horizonPlan, diag } = params;
  return latest.planStatus !== reportedPlanStatus(diag, horizonPlan)
    || (latest.dailyBudgetExhaustedBucketCount ?? 0) !== diag.dailyBudgetExhaustedBucketCount
    || (latest.floorShortfallCause ?? 'none') !== resolveFloorShortfallCause(diag.reasonCode);
};

const resolveSourceTransition = (params: {
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
const resolveLearnedRateKwh = (diag: DeferredObjectiveDiagnostic): number | null => {
  if (diag.kwhPerUnitSource !== 'learned') return null;
  // Use the sample-driven global mean, NOT `kWhPerPercent`/`kWhPerDegreeC`:
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
const hasLearnedRateDeviated = (params: {
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
const resolveInitialKwhPerUnit = (params: {
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
const toInitialKwhPerUnitField = (
  value: number | undefined,
): { initialKwhPerUnit?: number } => (
  value !== undefined ? { initialKwhPerUnit: value } : {}
);

const shouldWriteReplanRevision = (params: {
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
const MAX_HISTORY_REVISIONS = 20;

// `objectiveChanged` discards the previous commitment entirely and seeds a
// fresh one from the live `hours`. `scheduleChanged` (e.g. phase-2
// expansion grew the commitment) advances `committedAtMs` and persists the
// merged `effectiveHours`. Otherwise the existing commitment is preserved
// so within-schedule metadata drift doesn't visibly reshape the timestamp.
const resolveCommitment = (params: {
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

export class DeferredObjectiveActivePlanRecorder {
  private plans: Record<string, DeferredObjectiveActivePlanV1>;

  // In-memory only. Records the last cycle that emitted a diagnostic for the
  // device so abandon-grace works after settings reads. Initialized to
  // recorder construction time on reload so a transient SDK miss right after
  // restart does not delete persisted plans.
  private lastSeenAtMs: Map<string, number>;

  // In-memory only. Records the clock hour (floored ms) in which each device last
  // settled a replan revision, so the `:58` settle fires at most once per hour.
  // Not persisted: after a restart the first observe past `:58` simply re-settles,
  // which is a legitimate re-evaluation point.
  private lastScheduleSettledHourMs = new Map<string, number>();

  private dirty = false;

  constructor(private readonly deps: ActivePlanPersistDeps) {
    const loaded = deps.load();
    this.plans = loaded ? { ...loaded.plansByDeviceId } : {};
    const constructedAtMs = Date.now();
    this.lastSeenAtMs = new Map(Object.keys(this.plans).map((id) => [id, constructedAtMs]));
  }

  // Called from the flow card handler so the UI shows a pending hero immediately,
  // before the next plan cycle has a chance to compute a horizon.
  markPending(seed: ActivePlanFlowCardSeed, nowMs: number): void {
    const existing = this.plans[seed.deviceId];
    const signature = buildObjectiveSignature(seed);
    if (existing && existing.deadlineAtMs === seed.deadlineAtMs && existing.objectiveSignature === signature) {
      if (existing.deviceName !== seed.deviceName) {
        this.plans[seed.deviceId] = { ...existing, deviceName: seed.deviceName };
        this.dirty = true;
      }
      return;
    }
    const previousPlanStatus = existing !== undefined && existing.latest !== null && existing.deadlineAtMs > nowMs
      ? existing.latest.planStatus
      : null;
    this.plans[seed.deviceId] = createPlanFromSeed(seed, nowMs);
    this.lastSeenAtMs.set(seed.deviceId, nowMs);
    // Fresh plan (different deadline/signature): drop the prior settle marker so
    // the replacement is not wrongly treated as "already settled this hour".
    this.lastScheduleSettledHourMs.delete(seed.deviceId);
    this.dirty = true;
    if (previousPlanStatus !== null) {
      this.deps.onRevisionWritten?.({
        eventType: 'pending_written',
        deviceId: seed.deviceId,
        deviceName: seed.deviceName,
        objectiveKind: seed.objectiveKind,
        revision: null,
        reason: 'pending',
        previousPlanStatus,
        previousWasPending: false,
        allocationChanged: false,
        projectedFinishAtMs: null,
      });
    }
  }

  // Called from the flow card handler when the objective is cleared.
  clearForDevice(deviceId: string): void {
    if (this.plans[deviceId] === undefined) return;
    delete this.plans[deviceId];
    this.lastSeenAtMs.delete(deviceId);
    this.lastScheduleSettledHourMs.delete(deviceId);
    this.dirty = true;
  }

  // Per-cycle observation. Reads `horizonPlan` from each diagnostic and updates
  // the persisted plan iff a replan trigger fires.
  observe(diagnostics: readonly DeferredObjectiveDiagnostic[], nowMs: number): void {
    for (const diag of diagnostics) {
      if (diag.deadlineAtMs === null) continue;
      if (diag.deadlineAtMs <= nowMs) {
        this.dropPlanForRuntimeReason(diag.deviceId, 'deadline_passed');
        continue;
      }
      this.lastSeenAtMs.set(diag.deviceId, nowMs);
      this.observeDiagnostic(diag, nowMs);
    }
    this.dropExpiredAndAbandoned(nowMs);
  }

  private observeDiagnostic(diag: DeferredObjectiveDiagnostic, nowMs: number): void {
    const signature = buildSignatureFromDiagnostic(diag);
    if (signature === null) return;
    const existing = this.plans[diag.deviceId];
    // A previous record for a different deadline is stale — replace it.
    if (existing && existing.deadlineAtMs !== diag.deadlineAtMs) {
      delete this.plans[diag.deviceId];
      this.lastScheduleSettledHourMs.delete(diag.deviceId);
    }
    const candidateHours = buildHoursFromHorizonPlan(diag);
    if (candidateHours === null) {
      // Diagnostic without horizonPlan (e.g. prices missing): can't compute a
      // revision. Auto-create a pending record so the UI knows the objective
      // is being tracked. Unit milestones are stamped downstream — in
      // `writeFirstRevision` (no merge) and `maybeWriteReplanRevision` (on the
      // MERGED hours) — never on these pre-merge candidate hours, which the merge
      // would then preserve at the wrong (pre-floor / live-anchored) value.
      this.ensurePendingRecord(diag, signature, nowMs);
      return;
    }
    const current = this.plans[diag.deviceId];
    if (!current) {
      // No prior record; the recorder discovered the objective via the
      // diagnostic itself (e.g. objective enabled before this code shipped, or
      // app restarted without persisted state). Treat the original cause as
      // the flow card.
      this.writeFirstRevision(diag, signature, candidateHours, 'flow_card', nowMs);
      return;
    }
    if (current.pending || current.latest === null) {
      // Was waiting for prices (or freshly seeded); now we have an allocation.
      const reason: DeferredObjectiveActivePlanRevisionReason = current.pending && current.startedAtMs < nowMs
        ? 'prices_arrived'
        : 'flow_card';
      this.writeFirstRevision(diag, signature, candidateHours, reason, nowMs);
      return;
    }
    const backfilled = this.backfillCommitmentIfMissing(current, signature, nowMs);
    // End-of-hour settle gate: a replan revision settles at most once per clock
    // hour (at/after :58); a user objective edit bypasses it. The planner's
    // per-cycle live allocation is unaffected — only the persisted RECORD is
    // gated, so the device stays controlled while the record waits for the hour's
    // outcome. The hour's settle slot is consumed only when a revision is actually
    // written (`markReplanSettled` after a truthy write), so a no-op `:58` cycle
    // doesn't starve a real change later in the same `:58` window.
    const objectiveChanged = compareObjectiveSignatures(backfilled.objectiveSignature, signature).changed;
    if (!this.isReplanDueThisCycle(diag.deviceId, objectiveChanged, nowMs)) return;
    if (this.maybeWriteReplanRevision(diag, signature, candidateHours, backfilled, nowMs)) {
      this.markReplanSettled(diag.deviceId, nowMs);
    }
  }

  // Plans persisted before the stable-schedule commitment shipped (v2.7.3 and
  // earlier) carry `latest.hours` but no `commitment`, which causes
  // `maybeWriteReplanRevision` and `resolveCommittedHours` to keep treating the
  // allocation as advisory — the executor re-optimises every cycle. Quietly
  // adopt the existing `latest.hours` as the committed envelope so the
  // post-upgrade behaviour matches new plans. No revision is emitted: this is
  // a data-shape migration, not a user-visible replan.
  //
  // Caller has already ensured `!current.pending` and `current.latest !== null`.
  // Skipping when `latest.hours` is empty preserves the "no hours scheduled"
  // shape rather than committing to an empty envelope. We do not race with
  // `markPending` / `clearForDevice`: both run synchronously from flow card
  // handlers, and any plan with `latest !== null` has already left the pending
  // state — so by the time we reach this path the legacy record is stable
  // enough to commit.
  //
  // We also gate the backfill on the persisted `objectiveSignature` matching
  // the current diagnostic's resolved signature. When they differ (e.g. the
  // user changed the target/enforcement before the upgrade was observed), the
  // persisted `latest.hours` correspond to the OLD objective — committing to
  // them would lock in stale hours for the new target. In that case we skip;
  // `maybeWriteReplanRevision` will then detect the signature change and
  // write a fresh revision with the correct commitment via the first-revision
  // path.
  private backfillCommitmentIfMissing(
    current: DeferredObjectiveActivePlanV1,
    currentSignature: string,
    nowMs: number,
  ): DeferredObjectiveActivePlanV1 {
    if (current.commitment) return current;
    if (current.objectiveSignature !== currentSignature) return current;
    const latest = current.latest as DeferredObjectiveActivePlanRevisionV1;
    if (latest.hours.length === 0) return current;
    const backfilled: DeferredObjectiveActivePlanV1 = {
      ...current,
      commitment: {
        committedAtMs: nowMs,
        hours: latest.hours,
      },
    };
    this.plans[current.deviceId] = backfilled;
    this.dirty = true;
    return backfilled;
  }

  private ensurePendingRecord(
    diag: DeferredObjectiveDiagnostic,
    signature: string,
    nowMs: number,
  ): void {
    const pendingReason = resolvePendingReason(diag);
    const diagnosticReasonCode = resolveDiagnosticReasonCode(diag);
    const existing = this.plans[diag.deviceId];
    if (existing !== undefined) {
      // Refresh `pendingReason` (pending records only — it's meaningless for
      // executed plans) and `diagnosticReasonCode` (always — must surface the
      // current cause even on non-pending plans). The non-pending path matters
      // for the unplug-mid-schedule case: an EV with a persisted revision that
      // transitions to `objective_invalid_session` needs to drive the
      // "Charging plan paused — car unplugged" state on the device card.
      const reasonChanged = existing.pending && existing.pendingReason !== pendingReason;
      const diagChanged = existing.diagnosticReasonCode !== diagnosticReasonCode;
      if (reasonChanged || diagChanged) {
        const updated: DeferredObjectiveActivePlanV1 = existing.pending
          ? { ...existing, pendingReason }
          : { ...existing };
        if (diagnosticReasonCode !== undefined) {
          updated.diagnosticReasonCode = diagnosticReasonCode;
        } else {
          delete updated.diagnosticReasonCode;
        }
        this.plans[diag.deviceId] = updated;
        this.dirty = true;
      }
      return;
    }
    this.plans[diag.deviceId] = createPlanFromDiagnostic(diag, signature, nowMs);
    this.dirty = true;
    this.emit({
      event: 'active_plan_revision_pending',
      deviceId: diag.deviceId,
      reason: 'awaiting_horizon_plan',
      ...buildActivePlanLifecycleFields(diag, this.plans[diag.deviceId]!.startedAtMs),
    });
  }

  private writeFirstRevision(
    diag: DeferredObjectiveDiagnostic,
    signature: string,
    rawHours: DeferredObjectiveActivePlanHourV1[],
    reason: DeferredObjectiveActivePlanRevisionReason,
    nowMs: number,
  ): void {
    // First commit: no prior commitment to merge, so stamp the live hours directly
    // (the first hour seeds at the measured anchor; cumulative is correct). Stamp
    // the frozen `cheaperHourAhead` flag here too so the first committed hours
    // carry it from the start.
    const hours = stampCheaperHourAhead(stampUnitMilestones(rawHours, diag, nowMs), diag);
    const revision = buildRevision({ diag, hours, revision: 1, reason, nowMs });
    const previous = this.plans[diag.deviceId];
    const previousWasPending = previous !== undefined && (previous.pending || previous.latest === null);
    const startedAtMs = previous?.startedAtMs ?? nowMs;
    const provenance = resolveProvenance(diag);
    const initialKwhPerUnit = resolveLearnedRateKwh(diag);
    // Freeze the plan-level total duration here so the hero meta line stays
    // stable across revisions. See `resolvePlanLevelDurationSnapshot` for the
    // preservation/reset rules applied during subsequent revisions.
    this.plans[diag.deviceId] = {
      deviceId: diag.deviceId,
      deviceName: diag.deviceName ?? null,
      objectiveKind: diag.objectiveKind,
      targetTemperatureC: diagTargetTemperatureC(diag),
      targetPercent: diag.targetPercent,
      deadlineAtMs: diag.deadlineAtMs as number,
      startedAtMs,
      pending: false,
      objectiveSignature: signature,
      commitment: {
        committedAtMs: nowMs,
        hours,
      },
      ...(provenance ? { kwhPerUnitProvenance: provenance } : {}),
      // Freeze the committed learned-rate baseline for `measured_deviation`.
      // Omitted when the first revision is still on the bootstrap fallback (no
      // learned rate yet) — the baseline backfills on the first later cycle
      // whose source is `learned` (see `resolveInitialKwhPerUnit`).
      ...toInitialKwhPerUnitField(initialKwhPerUnit ?? undefined),
      ...(revision.planningSpeedKw !== undefined ? { initialPlanningSpeedKw: revision.planningSpeedKw } : {}),
      ...(revision.estimatedDurationText !== undefined
        ? { initialEstimatedDurationText: revision.estimatedDurationText }
        : {}),
      original: revision,
      latest: revision,
    };
    this.dirty = true;
    this.emit({
      event: 'active_plan_revision_written',
      deviceId: diag.deviceId,
      revision: 1,
      reason,
      hourCount: hours.length,
      ...buildActivePlanLifecycleFields(diag, startedAtMs),
    });
    if (previousWasPending) {
      this.deps.onRevisionWritten?.({
        eventType: 'revision_written',
        deviceId: diag.deviceId,
        deviceName: diag.deviceName ?? previous?.deviceName ?? null,
        objectiveKind: diag.objectiveKind,
        revision,
        reason,
        previousPlanStatus: null,
        previousWasPending: true,
        allocationChanged: false,
        projectedFinishAtMs: resolveProjectedFinishAtMs(diag),
      });
    }
  }

  // The once-per-hour `:58` settle gate (see SCHEDULE_SETTLE_OFFSET_MS). True when
  // a replan revision MAY be written this cycle: an external objective edit
  // (immediate) OR the first cycle at/after `:58` of this clock hour that has not
  // yet settled a write. PURE — the settle marker is advanced by
  // `markReplanSettled` only after a revision is ACTUALLY written, so a no-op
  // `:58` cycle (no schedule/metadata/source drift) does not consume the hour's
  // slot and a real change later in the `:58` window still lands. Within the hour
  // the persisted plan is otherwise frozen; the planner's per-cycle live
  // allocation still reacts (device stays controlled) — only the RECORD waits.
  private isReplanDueThisCycle(
    deviceId: string,
    objectiveChanged: boolean,
    nowMs: number,
  ): boolean {
    if (objectiveChanged) return true;
    const currentHourMs = Math.floor(nowMs / ONE_HOUR_MS) * ONE_HOUR_MS;
    const pastSettleMark = nowMs - currentHourMs >= SCHEDULE_SETTLE_OFFSET_MS;
    return pastSettleMark && this.lastScheduleSettledHourMs.get(deviceId) !== currentHourMs;
  }

  // Advance the settle marker after an actual `:58` write so the next cycle in the
  // same hour is frozen. Objective-edit writes that land mid-hour (before the
  // mark) do NOT consume the hour's settle slot — the end-of-hour settle still
  // runs to record the hour's outcome.
  private markReplanSettled(deviceId: string, nowMs: number): void {
    const currentHourMs = Math.floor(nowMs / ONE_HOUR_MS) * ONE_HOUR_MS;
    if (nowMs - currentHourMs >= SCHEDULE_SETTLE_OFFSET_MS) {
      this.lastScheduleSettledHourMs.set(deviceId, currentHourMs);
    }
  }

  private maybeWriteReplanRevision(
    diag: DeferredObjectiveDiagnostic,
    signature: string,
    hours: DeferredObjectiveActivePlanHourV1[],
    current: DeferredObjectiveActivePlanV1,
    nowMs: number,
  ): boolean {
    // Caller (`observeDiagnostic`) already returns early when `current.latest`
    // is null, so we can dereference it directly here.
    const latest = current.latest as DeferredObjectiveActivePlanRevisionV1;
    const horizonPlan = diag.horizonPlan as NonNullable<typeof diag.horizonPlan>;
    // `rescueOnly` routes to `flow_permission_changed` below so the history detail
    // names the Flow permission change, not a generic objective edit.
    const sigDiff = compareObjectiveSignatures(current.objectiveSignature, signature);
    const objectiveChanged = sigDiff.changed;
    // When the objective signature changes, the previous commitment is
    // discarded and the live `hours` become the new commitment. Otherwise
    // we merge live into commitment so per-cycle growth (within-hour drift
    // or phase-2 expansion) extends the commitment while the existing
    // committed kWh is preserved as a floor against transient shrinkage —
    // see `mergeHoursPreservingCommitment` for the merge rules.
    // Stamp the unit-trajectory milestones AND the frozen `cheaperHourAhead` flag
    // on the MERGED hours (not the pre-merge live plan): the Math.max floor can
    // raise an earlier hour's kWh, and the milestone cumulative must include that
    // or downstream milestones understate the target and the gate mis-releases.
    // Both stamps freeze per hour at the booking revision and carry through later
    // merges via `{ ...c }`. See `stampUnitMilestones` / `stampCheaperHourAhead`.
    const mergedHours = objectiveChanged
      ? hours
      : mergeHoursPreservingCommitment(current.commitment?.hours ?? [], hours, nowMs);
    const effectiveHours = stampCheaperHourAhead(stampUnitMilestones(mergedHours, diag, nowMs), diag);
    // Schedule change = user-visible "new plan" (set of charging hours).
    // Drives the `deadline_plan_changed` flow trigger.
    const scheduleChanged = !sameHourSchedule(latest.hours, effectiveHours);
    // Same charging hours but consumer-visible status fields drifted — see
    // `hasMetadataDriftedWithinSchedule` for the field list. Covers
    // `planStatus` transitions (drives the "Can't fully meet" chip) and
    // `dailyBudgetExhaustedBucketCount` (drives the per-bucket headroom
    // explanation). Per-cycle drift in `plannedKWh` / `energyNeededKWh` is
    // intentionally excluded to keep settings I/O budget in check on actively
    // charging EVs.
    const metadataDriftedWithinSchedule = !scheduleChanged
      && hasMetadataDriftedWithinSchedule({ latest, horizonPlan, diag });
    // Any kwhPerUnitSource change is a replan trigger so persisted metadata
    // (`kwhPerUnitSource`, `energyNeededKWh`, `planStatus`) cannot go stale
    // when the bucket allocation happens to be byte-identical across a source
    // flip. The reason is only `rate_refined` for the bootstrap→learned
    // direction; the rarer learned→bootstrap regression (profile pruned at
    // retention or device removed) falls through to `prices_revised`.
    //
    // `null` means the resolver did not consult a profile (e.g. target is
    // already satisfied so `energyNeededKWh = 0`). Treat that as "no source
    // change" rather than coercing it to `'learned'` — otherwise a bootstrap
    // revision followed by a satisfied diagnostic would spuriously fire
    // `rate_refined` even though nothing was learned.
    const { sourceChanged, sourceRefined } = resolveSourceTransition({ latest, diag });
    // The live learned per-unit energy rate (kWh/°C or kWh/%) drifted away from
    // the rate the committed plan was built against (`current.initialKwhPerUnit`)
    // — the device needs materially more/less energy per unit of progress than
    // planned, so the committed bucket allocation's energy assumption is stale.
    // Gated on a learned rate both sides (see `hasLearnedRateDeviated`), so
    // bootstrap/cold-start and idle live-power readings never reach it.
    // TODO: device_unavailable trigger — wired here once device-level metering
    // distinguishes "unreachable" from a slow reading.
    const measuredDeviation = hasLearnedRateDeviated({ current, diag, objectiveChanged });
    if (!shouldWriteReplanRevision({
      objectiveChanged,
      scheduleChanged,
      metadataDriftedWithinSchedule,
      sourceChanged,
      measuredDeviation,
    })) return false;
    const reason = resolveReplanReason({
      objectiveChanged,
      rescuePermissionOnlyChanged: sigDiff.rescueOnly,
      sourceRefined,
      measuredDeviation,
      pricesAdvanced: hasPriceHorizonAdvanced(latest, diag),
    });
    const nextRevision = latest.revision + 1;
    const revision = buildRevision({ diag, hours: effectiveHours, revision: nextRevision, reason, nowMs });
    const provenance = resolveProvenance(diag);
    // Provenance updates are best-effort; preserve the existing snapshot when
    // the new diagnostic didn't resolve a profile so we don't clobber useful
    // accepted-sample counts with a transient `null`. Don't carry the
    // snapshot across an objective-kind change on the same device id —
    // accepted-sample counts and confidence are kind-specific.
    const nextProvenance = provenance
      ?? (current.objectiveKind === diag.objectiveKind ? current.kwhPerUnitProvenance : undefined);
    const snapshot = resolvePlanLevelDurationSnapshot({ current, revision, reason });
    // Drop the prior snapshot fields from `...current` so the
    // `objective_changed` reset path can genuinely omit them when the new
    // revision has no usable planning speed. `toPersistedPlanLevelDurationFields`
    // then re-adds the keys only when the resolved snapshot has a value, so
    // the persisted JSON.stringify output stays identical to the prior
    // explicit-undefined idiom while the in-memory shape no longer exposes
    // `undefined` keys that violate `exactOptionalPropertyTypes`-style
    // contracts.
    const nextInitialKwhPerUnit = resolveInitialKwhPerUnit({
      current, diag, objectiveChanged, measuredDeviation,
    });
    const {
      initialPlanningSpeedKw: _droppedSnapshotSpeed,
      initialEstimatedDurationText: _droppedSnapshotDurationText,
      initialKwhPerUnit: _droppedInitialRate,
      ...currentWithoutSnapshot
    } = current;
    this.plans[diag.deviceId] = {
      ...currentWithoutSnapshot,
      deviceName: diag.deviceName ?? current.deviceName,
      objectiveKind: diag.objectiveKind,
      targetTemperatureC: diagTargetTemperatureC(diag),
      targetPercent: diag.targetPercent,
      objectiveSignature: signature,
      // Persist the merged `effectiveHours` as the commitment when the
      // schedule has changed (i.e. expansion added one or more new hours).
      // `committedAtMs` advances to nowMs on each grow so consumers can
      // reason about "when did this hour join the plan". When the schedule
      // is unchanged, preserve the existing commitment (including its
      // original `committedAtMs`) so within-schedule metadata drift doesn't
      // visibly reshape the commitment timestamp.
      commitment: resolveCommitment({
        objectiveChanged,
        scheduleChanged,
        effectiveHours,
        previous: current.commitment,
        nowMs,
      }),
      ...(nextProvenance ? { kwhPerUnitProvenance: nextProvenance } : {}),
      ...toPersistedPlanLevelDurationFields(snapshot),
      ...toInitialKwhPerUnitField(nextInitialKwhPerUnit),
      latest: revision,
      // Prepend the prior `latest` onto the history log, FIFO-pruned to the
      // cap so the persisted blob stays bounded. The head of the array is
      // always "the revision immediately before the current `latest`."
      //
      // Exception: when the smart-task settings themselves changed
      // (`reason === 'objective_changed'`), the prior history belongs to a
      // different objective (target, deadline, or device). Carrying it
      // forward would interleave pre-change revisions with the new
      // objective's revisions in the smart-task detail page revision panel
      // until 20 fresh entries rolled over. Clear instead — the new `latest`
      // revision carries reason `'objective_changed'` ("Smart task settings
      // changed"), which is itself the natural separator the user sees.
      //
      // Rescue-permission-only toggles (`reason === 'flow_permission_changed'`)
      // intentionally do NOT clear history: the target / deadline / device
      // are unchanged, and the user benefits from continuity of the prior
      // schedule's revisions across a permission edit.
      history: reason === 'objective_changed'
        ? []
        : [latest, ...(current.history ?? [])].slice(0, MAX_HISTORY_REVISIONS),
    };
    this.dirty = true;
    this.emit({
      event: 'active_plan_revision_written',
      deviceId: diag.deviceId,
      revision: nextRevision,
      reason,
      hourCount: effectiveHours.length,
      ...buildActivePlanLifecycleFields(diag, current.startedAtMs),
    });
    const allocationChanged = shouldFireNotification(
      latest.hours.length,
      effectiveHours.length,
      reportedPlanStatus(diag, horizonPlan),
    );
    notifyRevisionWrittenIfPubliclyObservable({
      deps: this.deps,
      diag,
      current,
      latest,
      revision,
      reason,
      allocationChanged,
    });
    return true;
  }

  private dropExpiredAndAbandoned(nowMs: number): void {
    for (const [deviceId, plan] of Object.entries(this.plans)) {
      if (plan.deadlineAtMs <= nowMs) {
        this.dropPlanForRuntimeReason(deviceId, 'deadline_passed');
        continue;
      }
      // Diagnostic stopped appearing while the deadline is still in the
      // future. This could be objective disabled, device unavailable, or a
      // transient empty Homey settings read. Wait for the abandon grace
      // before dropping so a single bad cycle does not delete persisted
      // state. A re-enabled objective produces a fresh objectiveSignature
      // which observe() picks up via objective_changed before grace expires.
      const lastSeen = this.lastSeenAtMs.get(deviceId) ?? nowMs;
      if (nowMs - lastSeen >= ABANDON_GRACE_MS) {
        this.dropPlanForRuntimeReason(deviceId, 'objective_inactive');
      }
    }
  }

  private dropPlanForRuntimeReason(
    deviceId: string,
    reason: 'deadline_passed' | 'objective_inactive',
  ): void {
    if (this.plans[deviceId] === undefined) return;
    delete this.plans[deviceId];
    this.lastSeenAtMs.delete(deviceId);
    this.lastScheduleSettledHourMs.delete(deviceId);
    this.dirty = true;
    this.emit({ event: 'active_plan_dropped', deviceId, reason });
  }

  flushIfDirty(): boolean {
    if (!this.dirty) return false;
    this.deps.save({
      version: DEFERRED_OBJECTIVE_ACTIVE_PLANS_VERSION,
      plansByDeviceId: { ...this.plans },
    });
    this.dirty = false;
    return true;
  }

  getActivePlansSnapshot(): DeferredObjectiveActivePlansV1 {
    return {
      version: DEFERRED_OBJECTIVE_ACTIVE_PLANS_VERSION,
      plansByDeviceId: { ...this.plans },
    };
  }

  // Test seam: expose internals for assertions without going through save().
  getPlanForTests(deviceId: string): DeferredObjectiveActivePlanV1 | undefined {
    return this.plans[deviceId];
  }

  resetForTests(): void {
    this.plans = {};
    this.lastSeenAtMs.clear();
    this.lastScheduleSettledHourMs.clear();
    this.dirty = false;
  }

  private emit(payload: Record<string, unknown>): void {
    if (this.deps.debugStructured) {
      this.deps.debugStructured(payload);
    } else {
      logger.debug(payload);
    }
  }
}
