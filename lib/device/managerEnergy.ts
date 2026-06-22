import type { HomeyDeviceLike } from '../utils/types';

export type LiveDevicePowerWatts = Record<string, number>;

type UnknownRecord = Record<string, unknown>;

const asRecord = (value: unknown): UnknownRecord | null => (
  typeof value === 'object' && value !== null ? value as UnknownRecord : null
);

const toFiniteNumber = (value: unknown): number | null => (
  typeof value === 'number' && Number.isFinite(value) ? value : null
);

export const extractLiveHomePowerWatts = (liveReport: unknown): number | null => {
  const report = asRecord(liveReport);
  if (!report || !Array.isArray(report.items)) return null;
  for (const rawItem of report.items) {
    const item = asRecord(rawItem);
    if (!item || item.type !== 'cumulative') continue;
    const values = asRecord(item.values);
    const watts = toFiniteNumber(values?.W);
    if (watts !== null) return watts;
  }
  return null;
};

/**
 * Gross PV generation in watts from the same `manager/energy/live` payload, or
 * `null` when no generation signal is present. PELS's whole-home `cumulative.W`
 * is NET grid power (consumption minus generation); to recover the authoritative
 * whole-home *actual consumption* (`net + generation`) for the managed/unmanaged
 * split, accounting needs the production term. Source per the solar plan: the
 * top-level `totalGenerated.W` aggregate, falling back to the `generator`-type
 * item. Generation is `+`-only; this never feeds the hard-cap import path.
 */
export const extractLiveGenerationWatts = (liveReport: unknown): number | null => {
  const report = asRecord(liveReport);
  if (!report) return null;
  const topLevel = toFiniteNumber(asRecord(report.totalGenerated)?.W);
  if (topLevel !== null) return Math.max(0, topLevel);
  if (!Array.isArray(report.items)) return null;
  for (const rawItem of report.items) {
    const item = asRecord(rawItem);
    if (!item || item.type !== 'generator') continue;
    const watts = toFiniteNumber(asRecord(item.values)?.W);
    if (watts !== null) return Math.max(0, watts);
  }
  return null;
};

export const extractLivePowerWattsByDeviceId = (liveReport: unknown): LiveDevicePowerWatts => {
  const report = asRecord(liveReport);
  if (!report || !Array.isArray(report.items)) return {};
  return Object.fromEntries(
    report.items.flatMap((rawItem) => {
      const item = asRecord(rawItem);
      if (!item || item.type !== 'device') return [];
      const deviceId = typeof item.id === 'string' ? item.id : null;
      if (!deviceId) return [];
      const values = asRecord(item.values);
      const watts = values?.W;
      if (typeof watts !== 'number' || !Number.isFinite(watts) || watts < 0) return [];
      return [[deviceId, watts] as const];
    }),
  );
};

export const hasPotentialHomeyEnergyEstimate = (device: HomeyDeviceLike): boolean => {
  const energy = asRecord(device.energyObj) || asRecord(device.energy);
  if (!energy) return false;

  const approx = asRecord(energy.approximation);
  const usageOnW = toFiniteNumber(approx?.usageOn);
  const usageOffW = toFiniteNumber(approx?.usageOff);
  if (usageOnW !== null && usageOffW !== null && usageOnW - usageOffW > 0) return true;
  if (usageOnW !== null && usageOnW > 0) return true;

  const energyW = toFiniteNumber(energy.W);
  return energyW !== null && energyW >= 0;
};
