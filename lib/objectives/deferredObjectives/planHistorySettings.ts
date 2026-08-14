import type {
  DeferredObjectiveActivePlanFloorShortfallCause,
  DeferredObjectiveActivePlanHourV1,
  DeferredObjectiveActivePlanStatusV1,
} from '../../../packages/contracts/src/deferredObjectiveActivePlans';
import type {
  DeferredObjectivePlanHistoryDiscoveredFrom,
  DeferredObjectivePlanHistoryEntry,
  DeferredObjectivePlanHistoryEntryV1,
  DeferredObjectivePlanHistoryEntryV2,
  DeferredObjectivePlanHistoryHourlyContribution,
  DeferredObjectivePlanHistoryHourlyTone,
  DeferredObjectivePlanHistoryObservedInterval,
  DeferredObjectivePlanHistoryProgressSample,
  DeferredObjectivePlanHistoryRecord,
  DeferredObjectivePlanHistoryRevisionLogEntry,
  DeferredObjectivePlanHistoryRevisionSnapshot,
  DeferredObjectivePlanHistoryV5,
  DeferredObjectivePlanMetReason,
  DeferredObjectivePlanOutcome,
} from '../../../packages/contracts/src/deferredObjectivePlanHistory';
import { toPlanHistoryRecord } from '../../../packages/shared-domain/src/deferredPlanHistoryResolvedView';
import { isFiniteNumber } from '../../utils/appTypeGuards';
import { randomUUID } from 'node:crypto';

// Bumped to 5 when persistence switched to compact, device-independent rows.
// v4 remains on its original settings key so a rollback can still read the
// old archive; the v5 adapter migrates that archive without overwriting it.
// v4 was introduced in v2.7.2 alongside the smart-task history-detail trio:
// `progressSamples`, `kwhPerUnitMean` (on revision snapshots), `deliveredKWh`
// + `totalCost`, `revisions[]`, and (extension, no version bump) the
// `costDisplay` price-display provenance. v4 is already released (shipped
// v2.7.2, live in v2.11.x), but no bump is needed for an additive OPTIONAL
// field: the normalizer validates every known field and compacts legacy rows,
// while preserving optional extensions on the record. A newer client treats
// an absent optional field as a graceful fallback. All new fields
// are optional so v3 entries continue to load with the field absent (graceful
// degrade); a `costDisplay`-less entry falls back to the recording-era øre/kr
// default. New entries are
// written at v5; v3/v4 reads are upgraded in-memory without
// dropping any persisted state — see `feedback_homey_sdk_unreliable` for the
// "never delete persisted state on a single empty/missing read" invariant.
export const DEFERRED_OBJECTIVE_PLAN_HISTORY_VERSION = 5 as const;

const createEmptyDeferredObjectivePlanHistory = (): DeferredObjectivePlanHistoryV5 => ({
  version: DEFERRED_OBJECTIVE_PLAN_HISTORY_VERSION,
  entries: [],
});

const isOutcome = (value: unknown): value is DeferredObjectivePlanOutcome => (
  value === 'met'
    || value === 'missed'
    || value === 'abandoned'
    || value === 'replaced'
    || value === 'unknown'
);

const isMetReason = (value: unknown): value is DeferredObjectivePlanMetReason => (
  value === 'stalled' || value === 'stalled_device_capped'
);

const isFiniteOrNull = (value: unknown): value is number | null => (
  value === null || isFiniteNumber(value)
);

const isObjectiveKind = (value: unknown): value is 'temperature' | 'ev_soc' => (
  value === 'temperature' || value === 'ev_soc'
);

const isDiscoveredFrom = (value: unknown): value is DeferredObjectivePlanHistoryDiscoveredFrom => (
  value === 'observation' || value === 'backfill'
);

const isObservedInterval = (value: unknown): value is DeferredObjectivePlanHistoryObservedInterval => {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return isFiniteNumber(v.fromMs) && isFiniteNumber(v.toMs);
};

const isPlanStatus = (value: unknown): value is DeferredObjectiveActivePlanStatusV1 => (
  value === 'at_risk'
    || value === 'cannot_meet'
    || value === 'invalid'
    || value === 'on_track'
    || value === 'satisfied'
);

const isPlanHour = (value: unknown): value is DeferredObjectiveActivePlanHourV1 => {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return isFiniteNumber(v.startsAtMs) && isFiniteNumber(v.plannedKWh);
};

const isRevisionSnapshot = (
  value: unknown,
): value is DeferredObjectivePlanHistoryRevisionSnapshot => {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  if (!Array.isArray(v.hours) || !v.hours.every(isPlanHour)) return false;
  if (!isFiniteNumber(v.energyNeededKWh)) return false;
  if (!isPlanStatus(v.planStatus)) return false;
  if (!isFiniteNumber(v.revisedAtMs)) return false;
  // `kwhPerUnitMean` added in v4. Optional — absence is the legacy shape.
  // When present it must be a finite positive number (kWh/°C or kWh/%);
  // anything else means the persisted snapshot was tampered with so drop it.
  if (v.kwhPerUnitMean !== undefined
    && (!isFiniteNumber(v.kwhPerUnitMean) || v.kwhPerUnitMean <= 0)) return false;
  if (!hasValidBudgetSignalFields(v)) return false;
  return hasValidMissAttributionFields(v);
};

// The two budget signals a snapshot can carry, both optional.
//
// `floorShortfallCause` (v2.9.1) is what every newly finalized entry carries —
// the producer-resolved reason the floor fell short.
// `dailyBudgetExhaustedBucketCount` (v2.7.2 PR 3) is RETIRED: nothing writes it
// any more, but history persisted by an older build still has it and must not
// be dropped on read, so the count is still accepted when finite and
// non-negative (including zero, which round-tripping tools can emit).
//
// Split out of `isRevisionSnapshot` to keep that guard under the
// cyclomatic-complexity cap.
// Keyed by the contract union so adding a cause fails to COMPILE here rather
// than silently reading as unknown and dropping the revision. The literal set
// has to live on this side: `packages/contracts` is types-only at runtime, so
// it cannot export a value for the guard to import.
const FLOOR_SHORTFALL_CAUSES: Record<DeferredObjectiveActivePlanFloorShortfallCause, true> = {
  budget: true,
  step_power: true,
  estimate: true,
  time_capacity: true,
  none: true,
};

const isFloorShortfallCause = (value: unknown): boolean => (
  typeof value === 'string' && Object.hasOwn(FLOOR_SHORTFALL_CAUSES, value)
);

const hasValidBudgetSignalFields = (v: Record<string, unknown>): boolean => {
  if (v.floorShortfallCause !== undefined && !isFloorShortfallCause(v.floorShortfallCause)) return false;
  return v.dailyBudgetExhaustedBucketCount === undefined
    || (isFiniteNumber(v.dailyBudgetExhaustedBucketCount)
      && v.dailyBudgetExhaustedBucketCount >= 0);
};

// Miss-attribution provenance added in v2.7.4. All optional — absence is the
// legacy shape. `rateConfidence` is the learned-rate band the run was planned
// against; `acceptedSamples` the count behind it (positive when written, but
// the validator accepts zero so round-tripped fixtures aren't dropped);
// `planningSpeedKw` the committed full-hour floor (kW, finite positive);
// `energyExpectedKWh` the mean-based plan total threaded from the live revision
// at finalize so the shared attribution helper can compare delivery against the
// mean rather than the buffered `plannedKWh` sum (must be finite positive when
// present — zero / negative / NaN means the persisted snapshot was tampered
// with so drop it). Split out of `isRevisionSnapshot` to keep that guard under
// the complexity cap.
const hasValidMissAttributionFields = (v: Record<string, unknown>): boolean => {
  if (v.rateConfidence !== undefined
    && v.rateConfidence !== 'low'
    && v.rateConfidence !== 'medium'
    && v.rateConfidence !== 'high') return false;
  if (v.acceptedSamples !== undefined
    && (!isFiniteNumber(v.acceptedSamples) || v.acceptedSamples < 0)) return false;
  if (v.planningSpeedKw !== undefined
    && (!isFiniteNumber(v.planningSpeedKw) || v.planningSpeedKw <= 0)) return false;
  if (v.energyExpectedKWh !== undefined
    && (!isFiniteNumber(v.energyExpectedKWh) || v.energyExpectedKWh <= 0)) return false;
  return true;
};

const isProgressSample = (
  value: unknown,
): value is DeferredObjectivePlanHistoryProgressSample => {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return isFiniteNumber(v.atMs) && isFiniteOrNull(v.valueC) && isFiniteOrNull(v.valuePercent);
};

const isResolvedProgressSample = (value: unknown): boolean => {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return isFiniteNumber(v.atMs) && isFiniteOrNull(v.value);
};

const isRevisionLogEntry = (
  value: unknown,
): value is DeferredObjectivePlanHistoryRevisionLogEntry => {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return isFiniteNumber(v.atMs)
    && typeof v.reasonId === 'string'
    && v.reasonId.length > 0
    && isFiniteNumber(v.hoursAdded)
    && isFiniteNumber(v.hoursRemoved);
};

const isHourlyTone = (value: unknown): value is DeferredObjectivePlanHistoryHourlyTone => (
  value === 'cheap' || value === 'normal' || value === 'expensive'
);

// Per-hour delivery contribution shape persisted on v4 entries. Recorder
// writes hour-aligned `atMs` (positive), non-negative `deliveredKWh`, finite
// `priceValue`, and a resolved tone (`recordHourlyDelivery` already rejects
// non-finite price/delivered values — see `lib/objectives/deferredObjectives/planHistory.ts`).
// A tampered payload could smuggle NaN price into the postmortem totals or
// an unknown tone string into the bar-strip colour mapper; reject those at
// the persistence boundary.
const isHourlyContribution = (
  value: unknown,
): value is DeferredObjectivePlanHistoryHourlyContribution => {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return isFiniteNumber(v.atMs)
    && v.atMs > 0
    && isFiniteNumber(v.deliveredKWh)
    && v.deliveredKWh >= 0
    && isFiniteNumber(v.priceValue)
    && isHourlyTone(v.tone);
};

// Price-display provenance persisted alongside `totalCost`. A tampered or
// downgraded payload could smuggle a non-string unit or a non-finite / zero /
// negative divisor that would mislabel or 100×-misscale the archived figure (a
// zero divisor would divide-by-zero at scale time). Reject those at the
// persistence boundary so the archive can trust the recorded display; a dropped
// `costDisplay` simply falls back to the recording-era øre/kr default on read.
const isCostDisplay = (value: unknown): boolean => {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return typeof v.unit === 'string' && isFiniteNumber(v.divisor) && v.divisor > 0;
};

// Delivery/cost trio (`deliveredKWh`, `totalCost`, `costDisplay`). All optional;
// each is rejected only when present-but-malformed so a legacy entry (any subset
// absent) still loads. Split out of `hasValidV4Extensions` to keep that
// validator under the branch-complexity cap.
const hasValidCostFields = (v: Record<string, unknown>): boolean => {
  if (v.deliveredKWh !== undefined
    && (!isFiniteNumber(v.deliveredKWh) || v.deliveredKWh < 0)) return false;
  if (v.totalCost !== undefined && !isFiniteNumber(v.totalCost)) return false;
  if (v.costDisplay !== undefined && !isCostDisplay(v.costDisplay)) return false;
  return true;
};

const hasValidV4Extensions = (v: Record<string, unknown>): boolean => {
  if (v.progressSamples !== undefined
    && (!Array.isArray(v.progressSamples) || !v.progressSamples.every(isProgressSample))) return false;
  if (!hasValidCostFields(v)) return false;
  if (v.revisions !== undefined
    && (!Array.isArray(v.revisions) || !v.revisions.every(isRevisionLogEntry))) return false;
  // v4 hourly-contribution strip: drop the whole entry when any contribution
  // is malformed so the postmortem bar strip can trust the persisted shape.
  // Per-entry "drop only the bad row" would be friendlier but is overkill —
  // the recorder writes via a single helper (`appendHourlyContribution`) that
  // can't produce mixed-shape rows in practice, so a malformed row signals
  // tampering or downgrade, not partial corruption.
  if (v.hourlyContributions !== undefined
    && (!Array.isArray(v.hourlyContributions)
      || !v.hourlyContributions.every(isHourlyContribution))) return false;
  return true;
};

const isRevisionSnapshotOrNull = (
  value: unknown,
): value is DeferredObjectivePlanHistoryRevisionSnapshot | null => (
  value === null || isRevisionSnapshot(value)
);

const hasValidIdentity = (v: Record<string, unknown>): boolean => (
  typeof v.deviceId === 'string'
    && (v.deviceName === null || typeof v.deviceName === 'string')
    && isObjectiveKind(v.objectiveKind)
);

const hasValidTargets = (v: Record<string, unknown>): boolean => (
  isFiniteOrNull(v.targetTemperatureC) && isFiniteOrNull(v.targetPercent)
);

const hasValidTimestamps = (v: Record<string, unknown>): boolean => (
  isFiniteNumber(v.deadlineAtMs)
    && isFiniteNumber(v.startedAtMs)
    && isFiniteNumber(v.finalizedAtMs)
    && isFiniteOrNull(v.metAtMs)
);

const hasValidProgress = (v: Record<string, unknown>): boolean => (
  isFiniteOrNull(v.startProgressC)
    && isFiniteOrNull(v.startProgressPercent)
    && isFiniteOrNull(v.finalProgressC)
    && isFiniteOrNull(v.finalProgressPercent)
    && isFiniteNumber(v.initialEnergyNeededKWh)
    // Optional; when present it must be a finite positive number. Anything else
    // means the persisted entry was tampered with, so drop it — same rule as
    // the snapshot-level `energyExpectedKWh`.
    && (v.initialEnergyExpectedKWh === undefined
      || (isFiniteNumber(v.initialEnergyExpectedKWh) && v.initialEnergyExpectedKWh > 0))
);

const hasValidOutcome = (v: Record<string, unknown>): boolean => {
  if (!isOutcome(v.outcome)) return false;
  if (typeof v.usedDeadlineReserve !== 'boolean') return false;
  // `metReason` is optional and only meaningful on `met` outcomes. Reject
  // entries that carry it on any other outcome (treat as schema tamper)
  // so the consumer never has to disambiguate "stalled but missed".
  if (v.metReason !== undefined) {
    if (!isMetReason(v.metReason)) return false;
    if (v.outcome !== 'met') return false;
  }
  return true;
};

const hasValidCoverage = (v: Record<string, unknown>): boolean => (
  Array.isArray(v.observedIntervals)
    && v.observedIntervals.every(isObservedInterval)
    && isDiscoveredFrom(v.discoveredFrom)
);

const hasValidPlanSnapshots = (v: Record<string, unknown>): boolean => (
  isRevisionSnapshotOrNull(v.originalPlan) && isRevisionSnapshotOrNull(v.finalPlan)
);

const isV1EntryShape = (value: unknown): value is DeferredObjectivePlanHistoryEntryV1 => {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return hasValidIdentity(v)
    && hasValidTargets(v)
    && hasValidTimestamps(v)
    && hasValidProgress(v)
    && hasValidOutcome(v);
};

const isV2EntryShape = (value: unknown): value is DeferredObjectivePlanHistoryEntryV2 => {
  if (!isV1EntryShape(value)) return false;
  const v = value as unknown as Record<string, unknown>;
  return hasValidCoverage(v);
};

const isPlanHistoryEntry = (value: unknown): value is DeferredObjectivePlanHistoryEntry => {
  if (!isV2EntryShape(value)) return false;
  const v = value as unknown as Record<string, unknown>;
  return typeof v.id === 'string'
    && v.id.length > 0
    && hasValidPlanSnapshots(v)
    && hasValidV4Extensions(v);
};

const isTerminalOutcome = (value: unknown): boolean => (
  value === 'met' || value === 'missed' || value === 'abandoned' || value === 'replaced'
);

const hasValidRecordValues = (v: Record<string, unknown>): boolean => (
  typeof v.id === 'string'
    && v.id.length > 0
    && typeof v.deviceId === 'string'
    && isFiniteOrNull(v.targetValue)
    && isFiniteOrNull(v.startProgressValue)
    && isFiniteOrNull(v.finalProgressValue)
);

const hasValidRecordProgress = (v: Record<string, unknown>): boolean => (
  hasValidProgress({
    ...v,
    startProgressC: v.startProgressValue,
    startProgressPercent: null,
    finalProgressC: v.finalProgressValue,
    finalProgressPercent: null,
  })
    && (v.progressSamples === undefined
      || (Array.isArray(v.progressSamples) && v.progressSamples.every(isResolvedProgressSample)))
);

const hasValidRecordExtensions = (v: Record<string, unknown>): boolean => (
  hasValidCostFields(v)
    && (v.revisions === undefined
      || (Array.isArray(v.revisions) && v.revisions.every(isRevisionLogEntry)))
    && (v.hourlyContributions === undefined
      || (Array.isArray(v.hourlyContributions) && v.hourlyContributions.every(isHourlyContribution)))
);

const isPlanHistoryRecord = (value: unknown): value is DeferredObjectivePlanHistoryRecord => {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  if (!hasValidRecordValues(v)) return false;
  if (!hasValidTimestamps(v) || !hasValidRecordProgress(v)) return false;
  if (!isTerminalOutcome(v.outcome) || !hasValidOutcome(v)) return false;
  if (!hasValidCoverage(v) || !hasValidPlanSnapshots(v)) return false;
  return hasValidRecordExtensions(v);
};

const upgradeV1Entry = (
  entry: DeferredObjectivePlanHistoryEntryV1,
): DeferredObjectivePlanHistoryEntry => ({
  ...entry,
  id: randomUUID(),
  observedIntervals: [{ fromMs: entry.startedAtMs, toMs: entry.finalizedAtMs }],
  discoveredFrom: 'observation',
  originalPlan: null,
  finalPlan: null,
});

const upgradeV2Entry = (
  entry: DeferredObjectivePlanHistoryEntryV2,
): DeferredObjectivePlanHistoryEntry => ({
  ...entry,
  id: randomUUID(),
  originalPlan: null,
  finalPlan: null,
});

const normalizeV1 = (entries: unknown[]): DeferredObjectivePlanHistoryEntry[] => (
  entries.filter(isV1EntryShape).map(upgradeV1Entry)
);

const normalizeV2 = (entries: unknown[]): DeferredObjectivePlanHistoryEntry[] => (
  entries.filter(isV2EntryShape).map(upgradeV2Entry)
);

// v3 and v4 entries share the same validation function: the v4-only fields
// (`progressSamples`, `deliveredKWh`, `totalCost`, `revisions[]`,
// `revisionSnapshot.kwhPerUnitMean`) are all optional, so v3 entries
// satisfy the legacy validator. v3/v4 → v5 also compacts the kind-split values
// while retaining every validated optional extension.
const normalizeV3OrV4 = (entries: unknown[]): DeferredObjectivePlanHistoryRecord[] => {
  const normalized: DeferredObjectivePlanHistoryRecord[] = [];
  for (const entry of entries) {
    if (isPlanHistoryRecord(entry)) {
      normalized.push(toPlanHistoryRecord(entry));
      continue;
    }
    if (isPlanHistoryEntry(entry)) normalized.push(toPlanHistoryRecord(entry));
  }
  return normalized;
};

export const normalizeDeferredObjectivePlanHistory = (
  raw: unknown,
): DeferredObjectivePlanHistoryV5 => {
  if (!raw || typeof raw !== 'object') return createEmptyDeferredObjectivePlanHistory();
  const r = raw as Record<string, unknown>;
  if (!Array.isArray(r.entries)) return createEmptyDeferredObjectivePlanHistory();
  // v3/v4 reads upgrade to compact v5 in-place. New fields stay absent on
  // legacy entries (graceful degrade per `feedback_homey_sdk_unreliable`).
  if (r.version === DEFERRED_OBJECTIVE_PLAN_HISTORY_VERSION || r.version === 4 || r.version === 3) {
    return {
      version: DEFERRED_OBJECTIVE_PLAN_HISTORY_VERSION,
      entries: normalizeV3OrV4(r.entries),
    };
  }
  if (r.version === 2) {
    return {
      version: DEFERRED_OBJECTIVE_PLAN_HISTORY_VERSION,
      entries: normalizeV2(r.entries).map(toPlanHistoryRecord),
    };
  }
  if (r.version === 1) {
    return {
      version: DEFERRED_OBJECTIVE_PLAN_HISTORY_VERSION,
      entries: normalizeV1(r.entries).map(toPlanHistoryRecord),
    };
  }
  return createEmptyDeferredObjectivePlanHistory();
};

/** Strict persistence parser. One malformed row makes the SDK read
 * unavailable so a partial snapshot can never be written over full history. */
export type DeferredObjectivePlanHistoryParseResult =
  | { state: 'resolved'; snapshot: DeferredObjectivePlanHistoryV5 }
  | { state: 'unavailable' };

export const parseDeferredObjectivePlanHistory = (
  raw: unknown,
): DeferredObjectivePlanHistoryParseResult => {
  if (!raw || typeof raw !== 'object') return { state: 'unavailable' };
  const candidate = raw as Record<string, unknown>;
  if (!Array.isArray(candidate.entries)) return { state: 'unavailable' };
  if (![1, 2, 3, 4, DEFERRED_OBJECTIVE_PLAN_HISTORY_VERSION].includes(candidate.version as number)) {
    return { state: 'unavailable' };
  }
  const normalized = normalizeDeferredObjectivePlanHistory(raw);
  if (normalized.entries.length !== candidate.entries.length) return { state: 'unavailable' };
  return { state: 'resolved', snapshot: normalized };
};
