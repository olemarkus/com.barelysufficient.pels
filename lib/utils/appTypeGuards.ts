import type { PowerTrackerState } from '../core/powerTracker';
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
    isOptionalNumber(state.lastPowerW),
    isOptionalNumber(state.lastControlledPowerW),
    isOptionalNumber(state.lastUncontrolledPowerW),
    isOptionalNumber(state.lastExemptPowerW),
    isOptionalNumber(state.lastTimestamp),
  ];
  return checks.every(Boolean);
}
