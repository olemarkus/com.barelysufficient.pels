import type {
  DeferredObjectiveActivePlanCommitmentV1,
  DeferredObjectiveActivePlanHourV1,
  DeferredObjectiveActivePlanRevisionReason,
  DeferredObjectiveActivePlanRevisionV1,
  DeferredObjectiveActivePlanStatusV1,
  DeferredObjectiveActivePlanV1,
  DeferredObjectiveActivePlansV1,
} from '../../../packages/contracts/src/deferredObjectiveActivePlans';
import { isFiniteNumber } from '../../utils/appTypeGuards';

export const DEFERRED_OBJECTIVE_ACTIVE_PLANS_VERSION = 1 as const;

const VALID_REASONS: ReadonlySet<DeferredObjectiveActivePlanRevisionReason> = new Set([
  'flow_card',
  'prices_arrived',
  'objective_changed',
  'prices_revised',
  // v2.7.3: schedule shifted without a fresher price horizon — daily-budget
  // pressure flipped a bucket, planStatus drifted, source flipped, etc.
  // Distinct from `prices_revised` so the UI label doesn't claim a Nordpool
  // publication event that didn't happen.
  'schedule_revised',
  'rate_refined',
  'device_unavailable',
  'measured_deviation',
  // A Flow toggled a rescue permission, prompting a re-solve under the new limits.
  // Listed here so a persisted revision carrying this reason survives rehydration
  // once the planner chunk starts emitting it (mirrors the `rate_refined` fix —
  // the type union and label maps alone don't gate persistence; this Set does).
  'flow_permission_changed',
]);

const isKwhPerUnitSource = (value: unknown): value is 'learned' | 'bootstrap' => (
  value === 'learned' || value === 'bootstrap'
);

// `rateMean` is the producer-resolved display rate; the contract allows
// `number | null`. The recorder only ever writes a finite POSITIVE number
// (`resolveRateMean` returns `null` for non-positive / non-finite rates and the
// field is then omitted). Accept `null` so a hand-edited/forward-compat payload
// that explicitly set it null round-trips rather than dropping the whole plan,
// but reject any non-positive number (0 / negative) the same way the recorder
// and the rate label formatter do — a non-positive rate is meaningless and
// would render garbage in the plan-inputs row.
const isOptionalRateMean = (value: unknown): boolean => (
  value === undefined || value === null || (isFiniteNumber(value) && value > 0)
);

// `speedMode` is the producer-resolved presentation enum. Optional for
// backward compatibility; when present require a known member so a tampered
// payload can't smuggle an unknown key that renders `undefined` in the hero
// meta line.
const isOptionalSpeedMode = (value: unknown): boolean => (
  value === undefined || value === 'auto' || value === 'learning'
);

export const createEmptyActivePlans = (): DeferredObjectiveActivePlansV1 => ({
  version: DEFERRED_OBJECTIVE_ACTIVE_PLANS_VERSION,
  plansByDeviceId: {},
});

const isFiniteOrNull = (value: unknown): value is number | null => (
  value === null || isFiniteNumber(value)
);

const isObjectiveKind = (value: unknown): value is 'temperature' | 'ev_soc' => (
  value === 'temperature' || value === 'ev_soc'
);

// Mirrors `isPlanStatus` in `planHistorySettings.ts`. The persisted revision's
// `planStatus` drives the hero/status chip ("Can't fully meet" / cold-start /
// on-track copy), so a tampered or downgraded payload that smuggled an unknown
// string would surface garbage status text. v2.9 closeout hardening.
const isPlanStatus = (value: unknown): value is DeferredObjectiveActivePlanStatusV1 => (
  value === 'at_risk'
    || value === 'cannot_meet'
    || value === 'invalid'
    || value === 'on_track'
    || value === 'satisfied'
);

const isReason = (value: unknown): value is DeferredObjectiveActivePlanRevisionReason => (
  typeof value === 'string'
  && VALID_REASONS.has(value as DeferredObjectiveActivePlanRevisionReason)
);

const isPlanHour = (value: unknown): value is DeferredObjectiveActivePlanHourV1 => {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return isFiniteNumber(v.startsAtMs) && isFiniteNumber(v.plannedKWh);
};

const isOptionalFinitePositive = (value: unknown): boolean => (
  value === undefined || (isFiniteNumber(value) && value > 0)
);

const isOptionalNonEmptyString = (value: unknown): boolean => (
  value === undefined || (typeof value === 'string' && value.length > 0)
);

// `energyExpectedKWh` is the mean-based estimate (no variance buffer). Recorder
// only writes a finite number; absence is the byte-stable "expected equals
// planned" shape. Reject negative/non-finite values rather than letting them
// reach the UI's range chip.
const isOptionalFiniteNonNegative = (value: unknown): boolean => (
  value === undefined || (isFiniteNumber(value) && value >= 0)
);

// `dailyBudgetExhaustedBucketCount` is the count of zero-cap horizon buckets.
// Recorder suppresses zero to keep persisted revisions byte-stable; the
// validator still accepts zero so a fixture or hand-edited payload that
// round-trips through normalize() isn't dropped.
const isOptionalNonNegativeCount = (value: unknown): boolean => (
  value === undefined || (isFiniteNumber(value) && value >= 0)
);

// `floorShortfallCause` is the producer-resolved verdict that routes the hero
// recourse (budget-bound → `Open Budget`, otherwise device-side). Optional for
// backward compatibility with revisions persisted before the field shipped.
// Accept any string here (not just the v2.9 enum values): a forward-compat
// cause string emitted by a future PELS version that the running v2.9.x
// consumer doesn't recognise would otherwise drop the WHOLE persisted plan
// via `.filter(isActivePlan)`, taking the revision history (`original`) with
// it. The consumer in `deadlinePlan.ts` already falls back gracefully on
// unknown values (it only branches on the `'budget'` literal and treats
// anything else as device-side recourse), so a string-typed unknown lands
// safely. Still reject non-string garbage (numbers, null, objects) so a
// genuinely tampered payload that smuggled e.g. `cause: 42` doesn't survive
// rehydration. Matches the contract type
// `DeferredObjectiveActivePlanFloorShortfallCause` for known values and
// degrades to "unknown but recognisable" for forward-compat strings.
const isOptionalFloorShortfallCause = (value: unknown): boolean => (
  value === undefined || typeof value === 'string'
);

// v2.9 hardening: `energyNeededKWh` and `planStatus` are required on every
// revision the recorder writes (see `buildRevision` in `activePlanRecorder.ts`),
// but the previous validator never checked them — a tampered or downgraded
// payload could carry an unknown status string or NaN energy figure all the
// way to the hero/status chip. `energyExpectedKWh`,
// `dailyBudgetExhaustedBucketCount`, and `floorShortfallCause` are optional
// but must round-trip cleanly when the recorder did persist them. Split out
// of `isRevision` so the top-level guard stays under the cyclomatic-complexity
// cap.
const hasValidRevisionEnergyFields = (v: Record<string, unknown>): boolean => (
  isFiniteNumber(v.energyNeededKWh)
    && isPlanStatus(v.planStatus)
    && isOptionalFiniteNonNegative(v.energyExpectedKWh)
    && isOptionalNonNegativeCount(v.dailyBudgetExhaustedBucketCount)
    && isOptionalFloorShortfallCause(v.floorShortfallCause)
);

// `kwhPerUnitSource` is optional for backward compatibility with revisions
// persisted before the bootstrap rate fallback shipped. Allow absence, but
// if present require a known value rather than silently keeping garbage.
// `planningSpeedKw` + `estimatedDurationText` are the per-revision duration
// snapshot, optional for backward compatibility.
//
// `speedMode` / `rateMean` are the producer-resolved flat display fields. The
// recorder (`buildRevision`) only ever writes them alongside `kwhPerUnitSource`
// — both are gated on `source !== null`, and `resolveRateMean` returns `null`
// (so the field is omitted) whenever the source short-circuited. Enforce that
// invariant here: a payload carrying `speedMode` or `rateMean` WITHOUT
// `kwhPerUnitSource` was never produced by this app and is treated as tampered.
// This keeps the persisted shape and the UI fallback in
// `resolveDisplayRateAndSpeedMode` consistent (legacy revisions carry neither
// field and fall back to the live profile; revisions that carry the flat fields
// always carry the source they were resolved from).
const hasValidRevisionDurationFields = (v: Record<string, unknown>): boolean => {
  if (v.kwhPerUnitSource === undefined
    && (v.speedMode !== undefined || v.rateMean !== undefined)) return false;
  return (v.kwhPerUnitSource === undefined || isKwhPerUnitSource(v.kwhPerUnitSource))
    && isOptionalFinitePositive(v.planningSpeedKw)
    && isOptionalNonEmptyString(v.estimatedDurationText)
    && isOptionalRateMean(v.rateMean)
    && isOptionalSpeedMode(v.speedMode);
};

const isRevision = (value: unknown): value is DeferredObjectiveActivePlanRevisionV1 => {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return isFiniteNumber(v.revision)
    && isFiniteNumber(v.revisedAtMs)
    && isFiniteOrNull(v.computedFromPricesUpTo)
    && isReason(v.reason)
    && Array.isArray(v.hours)
    && v.hours.every(isPlanHour)
    && hasValidRevisionEnergyFields(v)
    && hasValidRevisionDurationFields(v);
};

const isProvenanceConfidence = (value: unknown): value is 'low' | 'medium' | 'high' | null => (
  value === null || value === 'low' || value === 'medium' || value === 'high'
);

const isKwhPerUnitProvenance = (value: unknown): boolean => {
  if (value === undefined) return true;
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return isKwhPerUnitSource(v.source)
    && (v.kWhPerUnit === null || isFiniteNumber(v.kWhPerUnit))
    && isFiniteNumber(v.acceptedSamples)
    && isProvenanceConfidence(v.confidence)
    // `displayConfidence` is the band-aware aggregate driving the smart-task
    // chip; optional for backward compatibility with provenance snapshots
    // persisted before it shipped. When present must be a known band (or
    // `null` for bootstrap plans) — anything else means the payload was
    // tampered and the chip would render garbage.
    && (v.displayConfidence === undefined || isProvenanceConfidence(v.displayConfidence))
    && (v.lastAcceptedAtMs === null || isFiniteNumber(v.lastAcceptedAtMs));
};

const isRevisionOrNull = (value: unknown): value is DeferredObjectiveActivePlanRevisionV1 | null => (
  value === null || isRevision(value)
);

// `history` is optional for backward compatibility (legacy persisted plans
// don't carry it). When present must be an array of valid revisions — a
// tampered or downgraded payload that smuggles non-revision entries would
// otherwise leak into the UI's revision-log render. The recorder caps the
// array at `MAX_HISTORY_REVISIONS` on write; this validator only checks
// shape, not length, so a future cap change doesn't break load.
const isOptionalRevisionHistory = (
  value: unknown,
): value is DeferredObjectiveActivePlanRevisionV1[] | undefined => (
  value === undefined || (Array.isArray(value) && value.every(isRevision))
);

const isCommitment = (value: unknown): value is DeferredObjectiveActivePlanCommitmentV1 | undefined => {
  if (value === undefined) return true;
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return isFiniteNumber(v.committedAtMs)
    && Array.isArray(v.hours)
    && v.hours.every(isPlanHour);
};

const hasCoherentCommitmentState = (v: Record<string, unknown>): boolean => (
  v.commitment === undefined || v.latest !== null
);

// Identity-and-target fields the persisted plan must carry verbatim. Split
// out so `isActivePlan` keeps its complexity score below the codebase ceiling
// — the optional-snapshot / revision / provenance checks all live in their
// own helpers so the top-level guard stays readable.
const hasValidPlanIdentity = (v: Record<string, unknown>): boolean => (
  typeof v.deviceId === 'string'
    && (v.deviceName === null || typeof v.deviceName === 'string')
    && isObjectiveKind(v.objectiveKind)
    && isFiniteOrNull(v.targetTemperatureC)
    && isFiniteOrNull(v.targetPercent)
    && isFiniteNumber(v.deadlineAtMs)
    && isFiniteNumber(v.startedAtMs)
    && typeof v.pending === 'boolean'
    && typeof v.objectiveSignature === 'string'
);

// Plan-level duration snapshot (`initialPlanningSpeedKw` +
// `initialEstimatedDurationText`) is optional for backward compatibility with
// plans persisted before the snapshot shipped. Validates both fields together
// so a corrupt half-snapshot doesn't slip into typed downstream code.
const hasValidPlanLevelDurationSnapshot = (v: Record<string, unknown>): boolean => (
  isOptionalFinitePositive(v.initialPlanningSpeedKw)
    && isOptionalNonEmptyString(v.initialEstimatedDurationText)
    // Committed learned-rate baseline for measured_deviation. Optional and
    // positive, same backward-compat treatment as the duration snapshot.
    && isOptionalFinitePositive(v.initialKwhPerUnit)
);

const isActivePlan = (value: unknown): value is DeferredObjectiveActivePlanV1 => {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return hasValidPlanIdentity(v)
    && isRevisionOrNull(v.original)
    && isRevisionOrNull(v.latest)
    && isKwhPerUnitProvenance(v.kwhPerUnitProvenance)
    && hasValidPlanLevelDurationSnapshot(v)
    && isCommitment(v.commitment)
    && hasCoherentCommitmentState(v)
    && isOptionalRevisionHistory(v.history);
};

export const normalizeDeferredObjectiveActivePlans = (
  raw: unknown,
): DeferredObjectiveActivePlansV1 => {
  if (!raw || typeof raw !== 'object') return createEmptyActivePlans();
  const r = raw as Record<string, unknown>;
  if (r.version !== DEFERRED_OBJECTIVE_ACTIVE_PLANS_VERSION) return createEmptyActivePlans();
  if (!r.plansByDeviceId || typeof r.plansByDeviceId !== 'object') return createEmptyActivePlans();
  const entries = Object.entries(r.plansByDeviceId as Record<string, unknown>)
    .filter(([, plan]) => isActivePlan(plan)) as [string, DeferredObjectiveActivePlanV1][];
  return {
    version: DEFERRED_OBJECTIVE_ACTIVE_PLANS_VERSION,
    plansByDeviceId: Object.fromEntries(entries),
  };
};
