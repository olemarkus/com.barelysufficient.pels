import type { PowerTrackerState } from './tracker';
import { CAPACITY_QUARTER_MS } from '../../packages/shared-domain/src/settings/capacityPeriod';
import { isFiniteNumber } from '../../packages/shared-domain/src/numberGuards';
import { isNumberMap, isPlainObjectRecord } from '../utils/appTypeGuards';

// The parse boundary for a persisted power-tracker state: the plausibility guard
// the tracker store reads with, and the salvage pass that keeps what is sound in
// a partly corrupt one. Only `lib/power` reads a tracker state, so it lives here.

const SOLAR_RECORD_FIELDS = [
  'generationBuckets',
  'exportBuckets',
  'generationDailyTotals',
  'exportDailyTotals',
] as const;

// A retained solar kWh entry must be a finite, non-negative number — anything
// else would NaN-poison the prune fold (`foldAgedHourIntoDay` sums it into the
// daily total) or smuggle negative energy past the write-side clamps.
const isValidSolarKWh = (entry: unknown): entry is number => isFiniteNumber(entry) && entry >= 0;

/** null = the whole field is junk; otherwise the record with junk KEYS dropped. */
function sanitizeSolarRecord(field: unknown): Record<string, unknown> | null {
  if (!isPlainObjectRecord(field)) return null;
  const entries = Object.entries(field);
  const validEntries = entries.filter(([, entry]) => isValidSolarKWh(entry));
  if (validEntries.length === entries.length) return field;
  return Object.fromEntries(validEntries);
}

/**
 * Field- and key-level normalization for the optional solar families: a junk
 * value never fails the whole `isPlausiblePowerTrackerState` guard — an all-or-nothing
 * reject there would discard the entire tracker (billed import history
 * included) and let the next persist overwrite it. Granularity:
 *
 * - A field that is not a plain record (arrays, class instances, scalars) is
 *   dropped whole.
 * - Within a record, each retained VALUE must be a finite number ≥ 0 —
 *   offending keys are dropped, the rest of the record survives (a junk hour
 *   must not cost the healthy hours around it, and must never reach the prune
 *   fold where it would NaN-poison the daily total).
 * - `lastGenerationW` must be a finite number ≥ 0 or it is dropped.
 *
 * Non-object inputs and clean states pass through untouched (same reference).
 */
export function sanitizePowerTrackerSolarFields(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const blob = value as Record<string, unknown>;
  const patches = SOLAR_RECORD_FIELDS.flatMap((field) => {
    const current = blob[field];
    if (current === undefined) return [];
    const sanitizedField = sanitizeSolarRecord(current);
    return sanitizedField === current ? [] : [[field, sanitizedField] as const];
  });
  const badLatch = blob.lastGenerationW !== undefined && !isValidSolarKWh(blob.lastGenerationW);
  if (patches.length === 0 && !badLatch) return value;
  const sanitized = { ...blob };
  for (const [field, patch] of patches) {
    if (patch === null) {
      delete sanitized[field]; // eslint-disable-line functional/immutable-data
    } else {
      sanitized[field] = patch; // eslint-disable-line functional/immutable-data
    }
  }
  if (badLatch) delete sanitized.lastGenerationW; // eslint-disable-line functional/immutable-data
  return sanitized;
}

type UnknownPredicate = (value: unknown) => boolean;

const isOptional = (value: unknown, predicate: UnknownPredicate): boolean => (
  value === undefined || predicate(value)
);

const isOptionalArrayOf = (value: unknown, predicate: UnknownPredicate): boolean => (
  value === undefined || (Array.isArray(value) && value.every(predicate))
);

const isOptionalFiniteNumber = (value: unknown): boolean => (
  isOptional(value, isFiniteNumber)
);

const isOptionalNumberMap = (value: unknown): boolean => (
  isOptional(value, isNumberMap)
);

const isPowerTrackerMeterIdentity = (value: unknown): boolean => {
  if (!isPlainObjectRecord(value)) return false;
  const source = value.powerSource;
  const meterDeviceId = value.meterDeviceId;
  return (source === 'homey_energy' || source === 'flow')
    && (meterDeviceId === null || (typeof meterDeviceId === 'string' && meterDeviceId.length > 0));
};

const isHourlyAverage = (value: unknown): boolean => (
  isPlainObjectRecord(value)
  && isFiniteNumber(value.sum)
  && isFiniteNumber(value.count)
);

const isHourlyAverageMap = (value: unknown): boolean => (
  isPlainObjectRecord(value) && Object.values(value).every(isHourlyAverage)
);

const isOptionalHourlyAverageMap = (value: unknown): boolean => (
  isOptional(value, isHourlyAverageMap)
);

const isDeviceBucketMap = (value: unknown): boolean => (
  isPlainObjectRecord(value) && Object.values(value).every(isNumberMap)
);

const isUnreliablePeriod = (value: unknown): boolean => (
  isPlainObjectRecord(value)
  && isFiniteNumber(value.start)
  && isFiniteNumber(value.end)
);

const isObjectiveProfileConfidence = (value: unknown): boolean => (
  value === 'low' || value === 'medium' || value === 'high'
);

const isObjectiveProfileProgressDirection = (value: unknown): boolean => (
  value === 'increasing' || value === 'decreasing'
);

const isObjectiveProfileStat = (value: unknown): boolean => (
  isPlainObjectRecord(value)
  && isFiniteNumber(value.sampleCount)
  && isFiniteNumber(value.mean)
  && isFiniteNumber(value.m2)
  && isFiniteNumber(value.min)
  && isFiniteNumber(value.max)
  && isObjectiveProfileConfidence(value.confidence)
  && isFiniteNumber(value.lastUpdatedMs)
);

const isObjectiveProfileSample = (value: unknown): boolean => (
  isPlainObjectRecord(value)
  && isFiniteNumber(value.observedAtMs)
  && isFiniteNumber(value.value)
  && isOptional(value.progressDirection, isObjectiveProfileProgressDirection)
  && isOptionalFiniteNumber(value.crediblePowerW)
);

const isObjectiveProfileObservation = (value: unknown): boolean => (
  isPlainObjectRecord(value)
  && isFiniteNumber(value.observedAtMs)
  && isFiniteNumber(value.inputValue)
  && isFiniteNumber(value.kwhPerUnit)
  && isOptional(value.progressDirection, isObjectiveProfileProgressDirection)
  && isOptionalFiniteNumber(value.outdoorTemperatureC)
);

const isObjectiveProfileBand = (value: unknown): boolean => (
  isPlainObjectRecord(value)
  && isFiniteNumber(value.lowerInclusive)
  && isFiniteNumber(value.upperExclusive)
  && isFiniteNumber(value.sampleCount)
  && isFiniteNumber(value.mean)
  && isFiniteNumber(value.m2)
  && isObjectiveProfileConfidence(value.confidence)
);

const OBJECTIVE_PROFILE_REQUIRED_FINITE_FIELDS = [
  'updatedAtMs',
  'acceptedSamples',
  'rejectedSamples',
] as const;

const OBJECTIVE_PROFILE_OPTIONAL_FINITE_FIELDS = [
  'pendingEnergyKWh',
  'subIntervalStartMs',
  'subIntervalPowerW',
] as const;

const isDeviceObjectiveProfile = (value: unknown): boolean => {
  if (!isPlainObjectRecord(value)) return false;
  // No `kind` or sample `unit`: a profile records a value and a time, and this
  // layer has no notion of what the value measures. Nor the recovery-window
  // cluster (`recoveryTargetValue` / `recoveryArmedAtMs` /
  // `recoveryNoProgressSamples`), retired with the window itself. A blob
  // persisted before any of them were removed still validates — the extra keys
  // are ignored, not rejected — and the retired keys are then inert: nothing
  // reads them, so a profile that was mid-recovery at upgrade resumes learning
  // at once, guarded by the kWh/unit band instead.
  return OBJECTIVE_PROFILE_REQUIRED_FINITE_FIELDS.every(
      (field) => isFiniteNumber(value[field]),
    )
    && isObjectiveProfileSample(value.lastSample)
    && isOptional(value.kwhPerUnit, isObjectiveProfileStat)
    && isOptional(value.unitPerHour, isObjectiveProfileStat)
    && OBJECTIVE_PROFILE_OPTIONAL_FINITE_FIELDS.every(
      (field) => isOptionalFiniteNumber(value[field]),
    )
    && isOptionalArrayOf(value.samples, isObjectiveProfileObservation)
    && isOptionalArrayOf(value.bands, isObjectiveProfileBand)
    && isOptional(value.baselineMidStep, (flag) => flag === true);
};

const isObjectiveProfileMap = (value: unknown): boolean => (
  isPlainObjectRecord(value) && Object.values(value).every(isDeviceObjectiveProfile)
);

const NUMBER_MAP_FIELDS = [
  'buckets',
  'hourlySampleCounts',
  'hourlyBudgets',
  'dailyBudgetCaps',
  'dailyTotals',
  'controlledBuckets',
  'uncontrolledBuckets',
  'exemptBuckets',
  'controlledDailyTotals',
  'uncontrolledDailyTotals',
  'exemptDailyTotals',
  'lastDevicePowerWById',
  'generationBuckets',
  'exportBuckets',
  'generationDailyTotals',
  'exportDailyTotals',
] as const;

const isCapacityQuarter = (value: unknown): value is NonNullable<PowerTrackerState['capacityQuarter']> => (
  isPlainObjectRecord(value)
  && isFiniteNumber(value.startMs)
  && value.startMs >= 0
  && value.startMs % CAPACITY_QUARTER_MS === 0
  && isFiniteNumber(value.energyKWh)
  && value.energyKWh >= 0
  && isFiniteNumber(value.trackedMs)
  && value.trackedMs >= 0
  && value.trackedMs <= CAPACITY_QUARTER_MS
);

const isCapacityQuarterOnSamplingTimeline = (
  value: unknown,
  lastTimestamp: unknown,
): boolean => (
  isCapacityQuarter(value)
  && isFiniteNumber(lastTimestamp)
  && lastTimestamp >= value.startMs
  && lastTimestamp < value.startMs + CAPACITY_QUARTER_MS
  && value.trackedMs <= lastTimestamp - value.startMs
);

const isOptionalCapacityQuarterOnSamplingTimeline = (
  value: unknown,
  lastTimestamp: unknown,
): boolean => value === undefined || isCapacityQuarterOnSamplingTimeline(value, lastTimestamp);

const isCapacityMonthlyPeak = (value: unknown): boolean => (
  isPlainObjectRecord(value)
  && typeof value.monthKey === 'string'
  && /^\d{4}-\d{2}$/.test(value.monthKey)
  && isFiniteNumber(value.peakKw)
  && value.peakKw >= 0
);

const isOptionalCapacityMonthlyPeak = (value: unknown): boolean => (
  value === undefined || isCapacityMonthlyPeak(value)
);

const isStampWithin = (value: unknown, fromMs: number, toMs: number): boolean => (
  isFiniteNumber(value) && value >= fromMs && value <= toMs
);

/**
 * A held reading describes the latch it was written with: the same watts and
 * the same sample. A row left behind by a build that sampled without writing
 * it describes a latch that no longer exists, and would otherwise read as
 * contradicted (or frozen) on the first sample it happened to match.
 */
const isHeldReadingOnLatch = (value: unknown, lastPowerW: unknown, lastTimestamp: unknown): boolean => {
  if (!isPlainObjectRecord(value) || !isFiniteNumber(value.sinceMs) || !isFiniteNumber(value.atMs)) return false;
  const { sinceMs, atMs, baseline } = value;
  return isFiniteNumber(value.powerW) && value.powerW === lastPowerW && atMs === lastTimestamp && sinceMs <= atMs
    && isPlainObjectRecord(baseline) && isFiniteNumber(baseline.totalW) && isFiniteNumber(baseline.loadKey)
    && (value.contradictedAtMs === null || isStampWithin(value.contradictedAtMs, sinceMs, atMs))
    && (value.longHoldEndedAtMs === null || isStampWithin(value.longHoldEndedAtMs, 0, atMs));
};

/** The records written beside the sample latch: the open quarter, the month's peak, the held reading. */
const hasPlausibleLatchRecords = (value: Record<string, unknown>): boolean => (
  isOptionalCapacityQuarterOnSamplingTimeline(value.capacityQuarter, value.lastTimestamp)
  && isOptionalCapacityMonthlyPeak(value.capacityMonthlyPeak)
  && (value.heldReading === undefined || isHeldReadingOnLatch(value.heldReading, value.lastPowerW, value.lastTimestamp))
);

const HOURLY_AVERAGE_MAP_FIELDS = [
  'hourlyAverages',
  'controlledHourlyAverages',
  'uncontrolledHourlyAverages',
  'exemptHourlyAverages',
] as const;

const FINITE_NUMBER_FIELDS = [
  'lastGenerationW',
  'lastPowerW',
  'lastControlledPowerW',
  'lastUncontrolledPowerW',
  'lastExemptPowerW',
  'lastTimestamp',
] as const;

/**
 * Strict whole-shape plausibility for every home's tracker persistence
 * (`lib/power/homeTrackerPersistence.ts`). A rejected persisted blob is
 * classified suspect and left untouched, so rejecting one malformed nested
 * field cannot erase otherwise recoverable accounting.
 */
export function isPlausiblePowerTrackerState(value: unknown): value is PowerTrackerState {
  if (!isPlainObjectRecord(value)) return false;
  return (value.meterIdentity === undefined || isPowerTrackerMeterIdentity(value.meterIdentity))
    && NUMBER_MAP_FIELDS.every((field) => isOptionalNumberMap(value[field]))
    && HOURLY_AVERAGE_MAP_FIELDS.every((field) => isOptionalHourlyAverageMap(value[field]))
    && FINITE_NUMBER_FIELDS.every((field) => isOptionalFiniteNumber(value[field]))
    && hasPlausibleLatchRecords(value)
    && (value.deviceBuckets === undefined || isDeviceBucketMap(value.deviceBuckets))
    && (
      value.unreliablePeriods === undefined
      || (
        Array.isArray(value.unreliablePeriods)
        && value.unreliablePeriods.every(isUnreliablePeriod)
      )
    )
    && (
      value.objectiveProfiles === undefined
      || isObjectiveProfileMap(value.objectiveProfiles)
    );
}

export type SalvagedPowerTrackerState = {
  state: PowerTrackerState;
  /** What was dropped to get there: a field, or `field[n]` for n entries of a family. */
  dropped: readonly string[];
};

type Salvage = { blob: Record<string, unknown>; dropped: readonly string[] };
type SalvageStep = (salvage: Salvage) => Salvage;

const withoutField = (record: Record<string, unknown>, field: string): Record<string, unknown> => (
  Object.fromEntries(Object.entries(record).filter(([key]) => key !== field))
);

/** Keep the entries of a keyed family that pass `keep`; a family that is not a record goes whole. */
const salvageFamily = (field: string, keep: UnknownPredicate): SalvageStep => (salvage) => {
  const current = salvage.blob[field];
  if (current === undefined) return salvage;
  if (!isPlainObjectRecord(current)) {
    return { blob: withoutField(salvage.blob, field), dropped: [...salvage.dropped, field] };
  }
  const entries = Object.entries(current);
  const kept = entries.filter(([, entry]) => keep(entry));
  if (kept.length === entries.length) return salvage;
  return {
    blob: { ...salvage.blob, [field]: Object.fromEntries(kept) },
    dropped: [...salvage.dropped, `${field}[${entries.length - kept.length}]`],
  };
};

/** Drop a scalar field that fails `keep`. */
const salvageScalar = (field: string, keep: UnknownPredicate): SalvageStep => (salvage) => (
  salvage.blob[field] === undefined || keep(salvage.blob[field])
    ? salvage
    : { blob: withoutField(salvage.blob, field), dropped: [...salvage.dropped, field] }
);

/** Per device, the finite hours; a device with none, or that is not a record, goes. */
const salvageDeviceBuckets: SalvageStep = (salvage) => {
  const current = salvage.blob.deviceBuckets;
  if (current === undefined) return salvage;
  if (!isPlainObjectRecord(current)) {
    return { blob: withoutField(salvage.blob, 'deviceBuckets'), dropped: [...salvage.dropped, 'deviceBuckets'] };
  }
  const devices = Object.entries(current).map(([deviceId, hours]) => {
    const entries = isPlainObjectRecord(hours) ? Object.entries(hours) : [];
    const finite = entries.filter((entry): entry is [string, number] => isFiniteNumber(entry[1]));
    return { deviceId, finite, dropped: isPlainObjectRecord(hours) ? entries.length - finite.length : 1 };
  });
  const dropped = devices.reduce((sum, device) => sum + device.dropped, 0);
  if (dropped === 0) return salvage;
  const kept = devices.filter((device) => device.finite.length > 0)
    .map(({ deviceId, finite }) => [deviceId, Object.fromEntries(finite)] as const);
  return {
    blob: { ...salvage.blob, deviceBuckets: Object.fromEntries(kept) },
    dropped: [...salvage.dropped, `deviceBuckets[${dropped}]`],
  };
};

const salvageCapacityQuarter: SalvageStep = (salvage) => (
  salvage.blob.capacityQuarter === undefined
  || isCapacityQuarterOnSamplingTimeline(salvage.blob.capacityQuarter, salvage.blob.lastTimestamp)
    ? salvage
    : {
      blob: withoutField(salvage.blob, 'capacityQuarter'),
      dropped: [...salvage.dropped, 'capacityQuarter'],
    }
);

const isUnreliablePeriodList = (value: unknown): boolean => (
  Array.isArray(value) && value.every(isUnreliablePeriod)
);

/** The solar families and latch are held to the solar check (finite, ≥ 0); the rest to finiteness. */
const numberMapEntryCheck = (field: string): UnknownPredicate => (
  (SOLAR_RECORD_FIELDS as readonly string[]).includes(field) ? isValidSolarKWh : isFiniteNumber
);

// Every structured field is judged on its own check, never by whether the
// whole blob turns plausible without it: two bad ones would otherwise cover
// for each other and cost the families around them.
const SALVAGE_STEPS: readonly SalvageStep[] = [
  ...NUMBER_MAP_FIELDS.map((field) => salvageFamily(field, numberMapEntryCheck(field))),
  ...HOURLY_AVERAGE_MAP_FIELDS.map((field) => salvageFamily(field, isHourlyAverage)),
  ...FINITE_NUMBER_FIELDS.map((field) => (
    salvageScalar(field, field === 'lastGenerationW' ? isValidSolarKWh : isFiniteNumber)
  )),
  salvageCapacityQuarter,
  salvageScalar('capacityMonthlyPeak', isCapacityMonthlyPeak),
  salvageDeviceBuckets,
  salvageScalar('meterIdentity', isPowerTrackerMeterIdentity),
  salvageScalar('unreliablePeriods', isUnreliablePeriodList),
  salvageScalar('objectiveProfiles', isObjectiveProfileMap),
];

/**
 * The most of a persisted tracker blob that `isPlausiblePowerTrackerState`
 * accepts: entries that fail a family's check are dropped one at a time
 * (a `null` an older release stringified from a NaN, a junk hour), a scalar
 * the guard refuses is dropped whole, and only a blob with nothing plausible
 * left answers `null`. This is the one-shot import's reading of a blob the
 * previous release wrote under a looser guard: a single bad entry must never
 * cost the history around it. Clean blobs come back unchanged, `dropped` empty;
 * every removal — the solar families' included — is named there, so the
 * import's log says what an upgrade discarded.
 */
export function salvagePowerTrackerState(value: unknown): SalvagedPowerTrackerState | null {
  if (!isPlainObjectRecord(value)) return null;
  let salvage: Salvage = { blob: value, dropped: [] };
  for (const step of SALVAGE_STEPS) salvage = step(salvage);
  const { blob, dropped } = salvage;
  return isPlausiblePowerTrackerState(blob) ? { state: blob, dropped } : null;
}
