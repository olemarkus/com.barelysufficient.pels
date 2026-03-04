import type Homey from 'homey';
import type { HomeyDeviceLike, Logger, TargetDeviceSnapshot } from '../utils/types';
import type { PowerMeasurementUpdates } from './powerMeasurement';

export function updateLastKnownPower(params: {
  state: { lastKnownPowerKw: Record<string, number> };
  logger: Logger;
  deviceId: string;
  measuredKw: number;
  deviceLabel: string;
}): void {
  const {
    state,
    logger,
    deviceId,
    measuredKw,
    deviceLabel,
  } = params;
  const previousPeak = state.lastKnownPowerKw[deviceId] || 0;
  if (measuredKw > previousPeak) {
    state.lastKnownPowerKw[deviceId] = measuredKw;
    logger.debug(`Power estimate: updated peak power for ${deviceLabel}: ${measuredKw.toFixed(3)} kW (was ${previousPeak.toFixed(3)} kW)`);
  }
}

export function applyMeasurementUpdates(params: {
  state: {
    lastKnownPowerKw: Record<string, number>;
    lastMeterEnergyKwh: Record<string, { kwh: number; ts: number }>;
    lastMeasuredPowerKw: Record<string, { kw: number; ts: number }>;
  };
  logger: Logger;
  deviceId: string;
  updates: PowerMeasurementUpdates;
  deviceLabel: string;
}): void {
  const {
    state,
    logger,
    deviceId,
    updates,
    deviceLabel,
  } = params;
  if (updates.lastMeterEnergyKwh) {
    state.lastMeterEnergyKwh[deviceId] = updates.lastMeterEnergyKwh;
  }
  if (updates.lastMeasuredPowerKw) {
    state.lastMeasuredPowerKw[deviceId] = updates.lastMeasuredPowerKw;
    updateLastKnownPower({ state, logger, deviceId, measuredKw: updates.lastMeasuredPowerKw.kw, deviceLabel });
  }
}

export function handlePowerUpdate(params: {
  state: {
    lastMeasuredPowerKw: Record<string, { kw: number; ts: number }>;
    lastKnownPowerKw: Record<string, number>;
  };
  logger: Logger;
  latestSnapshot: TargetDeviceSnapshot[];
  deviceId: string;
  label: string;
  value: number | null;
}): void {
  const {
    state,
    logger,
    latestSnapshot,
    deviceId,
    label,
    value,
  } = params;
  if (typeof value !== 'number' || !Number.isFinite(value)) return;

  const measuredKw = value / 1000;
  state.lastMeasuredPowerKw[deviceId] = { kw: measuredKw, ts: Date.now() };
  updateLastKnownPower({ state, logger, deviceId, measuredKw, deviceLabel: label });

  const snapshot = latestSnapshot.find((entry) => entry.id === deviceId);
  if (!snapshot) return;
  snapshot.measuredPowerKw = measuredKw;
  snapshot.powerKw = measuredKw;
}

export async function getRawDevices(
  homey: Homey.App,
  path: string,
): Promise<Record<string, HomeyDeviceLike> | HomeyDeviceLike[]> {
  const api = extractHomeyApi(homey);
  if (!api?.get) {
    throw new Error('Homey API client not available');
  }
  const data = await api.get(path);
  if (Array.isArray(data)) return data as HomeyDeviceLike[];
  if (typeof data === 'object' && data !== null) return data as Record<string, HomeyDeviceLike>;
  return [];
}

export function writeErrorToStderr(message: string, error: unknown): void {
  const stderr = typeof process !== 'undefined' ? process.stderr : undefined;
  if (!stderr || typeof stderr.write !== 'function') return;
  const errorText = error instanceof Error ? (error.stack || error.message) : String(error);
  try {
    stderr.write(`[PelsApp] ${message} ${errorText}\n`);
  } catch (_) {
    // ignore stderr failures
  }
}

export function resolveHomeyInstance(homey: Homey.App): Homey.App['homey'] {
  if (isHomeyAppWrapper(homey)) {
    return homey.homey;
  }
  return homey as unknown as Homey.App['homey'];
}

function isHomeyAppWrapper(value: unknown): value is { homey: Homey.App['homey'] } {
  return typeof value === 'object' && value !== null && 'homey' in value;
}

function extractHomeyApi(homey: Homey.App): { get?: (path: string) => Promise<unknown> } | undefined {
  const homeyInstance = resolveHomeyInstance(homey);
  return (homeyInstance as { api?: { get?: (path: string) => Promise<unknown> } }).api;
}
