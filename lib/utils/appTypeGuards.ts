import type { PowerTrackerState } from '../core/powerTracker';
import type { DeviceControlProfiles } from '../../packages/contracts/src/types';
import { normalizeDeviceControlProfiles } from './deviceControlProfiles';

export function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

export function isStringMap(value: unknown): value is Record<string, string> {
  if (!value || typeof value !== 'object') return false;
  return Object.entries(value).every(([key, entry]) => typeof key === 'string' && typeof entry === 'string');
}

export function isBooleanMap(value: unknown): value is Record<string, boolean> {
  if (!value || typeof value !== 'object') return false;
  return Object.entries(value).every(([key, entry]) => typeof key === 'string' && typeof entry === 'boolean');
}

export function isNumberMap(value: unknown): value is Record<string, number> {
  if (!value || typeof value !== 'object') return false;
  return Object.entries(value).every(([key, entry]) => typeof key === 'string' && isFiniteNumber(entry));
}

export function isCommunicationModelMap(value: unknown): value is Record<string, 'local' | 'cloud'> {
  if (!value || typeof value !== 'object') return false;
  return Object.entries(value).every(([key, entry]) => (
    typeof key === 'string' && (entry === 'local' || entry === 'cloud')
  ));
}

export function isPrioritySettings(value: unknown): value is Record<string, Record<string, number>> {
  if (!value || typeof value !== 'object') return false;
  return Object.values(value as Record<string, unknown>).every((mode) => {
    if (!mode || typeof mode !== 'object') return false;
    return Object.values(mode as Record<string, unknown>).every((entry) => isFiniteNumber(entry));
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
