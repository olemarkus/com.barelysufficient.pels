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

export function isCommunicationModelMap(value: unknown): value is Record<string, 'local' | 'cloud'> {
  if (!isPlainObjectRecord(value)) return false;
  return Object.entries(value).every(([key, entry]) => (
    typeof key === 'string' && (entry === 'local' || entry === 'cloud')
  ));
}

export function isPrioritySettings(value: unknown): value is Record<string, Record<string, number>> {
  if (!isPlainObjectRecord(value)) return false;
  return Object.values(value).every((mode) => {
    if (!isPlainObjectRecord(mode)) return false;
    return Object.values(mode).every((entry) => isFiniteNumber(entry));
  });
}

export function isModeDeviceTargets(value: unknown): value is Record<string, Record<string, number>> {
  return isPrioritySettings(value);
}

export function isDeviceControlProfiles(value: unknown): value is DeviceControlProfiles {
  if (!value || typeof value !== 'object') return false;
  const normalized = normalizeDeviceControlProfiles(value);
  if (!normalized) return false;
  return Object.keys(normalized).length === Object.keys(value as Record<string, unknown>).length;
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
 * value never fails the whole `isPowerTrackerState` guard — an all-or-nothing
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

export function isPowerTrackerState(value: unknown): value is PowerTrackerState {
  if (!value || typeof value !== 'object') return false;
  const state = value as PowerTrackerState;
  const isOptionalRecord = (entry: unknown) => entry === undefined || typeof entry === 'object';
  const isOptionalNumber = (entry: unknown) => entry === undefined || typeof entry === 'number';
  const checks = [
    isOptionalRecord(state.buckets),
    isOptionalRecord(state.hourlyBudgets),
    isOptionalRecord(state.dailyBudgetCaps),
    isOptionalRecord(state.dailyTotals),
    isOptionalRecord(state.hourlyAverages),
    isOptionalRecord(state.controlledBuckets),
    isOptionalRecord(state.uncontrolledBuckets),
    isOptionalRecord(state.exemptBuckets),
    isOptionalRecord(state.objectiveProfiles),
    isOptionalRecord(state.controlledDailyTotals),
    isOptionalRecord(state.uncontrolledDailyTotals),
    isOptionalRecord(state.exemptDailyTotals),
    isOptionalRecord(state.controlledHourlyAverages),
    isOptionalRecord(state.uncontrolledHourlyAverages),
    isOptionalRecord(state.exemptHourlyAverages),
    isOptionalRecord(state.generationBuckets),
    isOptionalRecord(state.exportBuckets),
    isOptionalRecord(state.generationDailyTotals),
    isOptionalRecord(state.exportDailyTotals),
    isOptionalNumber(state.lastGenerationW),
    isOptionalNumber(state.lastPowerW),
    isOptionalNumber(state.lastControlledPowerW),
    isOptionalNumber(state.lastUncontrolledPowerW),
    isOptionalNumber(state.lastExemptPowerW),
    isOptionalNumber(state.lastTimestamp),
  ];
  return checks.every(Boolean);
}
