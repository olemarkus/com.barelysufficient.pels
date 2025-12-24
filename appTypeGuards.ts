import type { PowerTrackerState } from './powerTracker';

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

export function isPowerTrackerState(value: unknown): value is PowerTrackerState {
  if (!value || typeof value !== 'object') return false;
  const state = value as PowerTrackerState;
  const bucketsOk = state.buckets === undefined || typeof state.buckets === 'object';
  const budgetsOk = state.hourlyBudgets === undefined || typeof state.hourlyBudgets === 'object';
  const dailyOk = state.dailyTotals === undefined || typeof state.dailyTotals === 'object';
  const averagesOk = state.hourlyAverages === undefined || typeof state.hourlyAverages === 'object';
  const lastPowerOk = state.lastPowerW === undefined || typeof state.lastPowerW === 'number';
  const lastTsOk = state.lastTimestamp === undefined || typeof state.lastTimestamp === 'number';
  return bucketsOk && budgetsOk && dailyOk && averagesOk && lastPowerOk && lastTsOk;
}
