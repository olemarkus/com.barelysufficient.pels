import type { PowerTrackerState } from '../power/tracker';
import type {
  DeviceControlProfiles,
  EvBoostSettings,
  TemperatureBoostSettings,
} from '../../packages/contracts/src/types';
import {
  normalizeTemperatureBoostSettings as normalizeTemperatureBoostSettingsContract,
} from './temperatureBoost';
import { normalizeDeviceControlProfiles } from './deviceControlProfiles';
import { normalizeEvBoostSettings as normalizeEvBoostSettingsRuntime } from './evBoost';

export function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * Returns true when the input is a plain object literal (Object.prototype or
 * a bare null-prototype object). Rejects arrays, class instances, Date, Map,
 * Set, etc. — Homey settings persistence only round-trips plain objects.
 */
function isPlainObjectRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype: object | null = Object.getPrototypeOf(value) as object | null;
  return prototype === Object.prototype || prototype === null;
}

export function isStringMap(value: unknown): value is Record<string, string> {
  if (!isPlainObjectRecord(value)) return false;
  return Object.entries(value).every(([key, entry]) => typeof key === 'string' && typeof entry === 'string');
}

export function isBooleanMap(value: unknown): value is Record<string, boolean> {
  if (!isPlainObjectRecord(value)) return false;
  return Object.entries(value).every(([key, entry]) => typeof key === 'string' && typeof entry === 'boolean');
}

export function isNumberMap(value: unknown): value is Record<string, number> {
  if (!isPlainObjectRecord(value)) return false;
  return Object.entries(value).every(([key, entry]) => typeof key === 'string' && isFiniteNumber(entry));
}

export function isPrioritySettings(value: unknown): value is Record<string, Record<string, number>> {
  if (!isPlainObjectRecord(value)) return false;
  return Object.values(value).every((mode) => {
    if (!isPlainObjectRecord(mode)) return false;
    return Object.values(mode).every((entry) => isFiniteNumber(entry));
  });
}

export function isDeviceControlProfiles(value: unknown): value is DeviceControlProfiles {
  if (!value || typeof value !== 'object') return false;
  const normalized = normalizeDeviceControlProfiles(value);
  if (!normalized) return false;
  return Object.keys(normalized).length === Object.keys(value).length;
}

export function normalizeTemperatureBoostSettings(value: unknown): TemperatureBoostSettings {
  return normalizeTemperatureBoostSettingsContract(value);
}

export function normalizeEvBoostSettings(value: unknown): EvBoostSettings {
  return normalizeEvBoostSettingsRuntime(value);
}

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
  && isOptionalFiniteNumber(value.crediblePowerW)
  && (
    value.powerSource === undefined
    || value.powerSource === 'measured'
    || value.powerSource === 'reported_step_planning'
  )
);

const isObjectiveProfileObservation = (value: unknown): boolean => (
  isPlainObjectRecord(value)
  && isFiniteNumber(value.observedAtMs)
  && isFiniteNumber(value.inputValue)
  && isFiniteNumber(value.kwhPerUnit)
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
    && isOptionalArrayOf(value.bands, isObjectiveProfileBand);
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
  const start: Salvage = { blob: value, dropped: [] };
  const { blob, dropped } = SALVAGE_STEPS.reduce<Salvage>((salvage, step) => step(salvage), start);
  return isPlausiblePowerTrackerState(blob) ? { state: blob, dropped } : null;
}
