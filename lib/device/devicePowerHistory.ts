import { isUnknownRecord } from '../../packages/shared-domain/src/recordGuards';
import { normalizeMeasuredPowerKw } from '../../packages/shared-domain/src/measuredPowerObservedState';
import { rankedPeakLevelKw, recordPeakReading, type PeakReadings } from './devicePowerPeak';
import type { MeterHistoryPeak } from './learnedPowerPeakState';

const HOUR_MS = 60 * 60 * 1000;
const MAX_BUCKET_MS = 5000;
const MAX_POINTS = 1000;

export type MeterPowerLog = { ownerUri: string; id: string };

/** Homey usually publishes device watts under energy_power, with some meters exposing measure_power. */
export function findMeterPowerLog(raw: unknown, sourceDeviceId: string): MeterPowerLog | undefined {
  if (!isUnknownRecord(raw) && !Array.isArray(raw)) return undefined;
  const logs: readonly unknown[] = Object.values(raw);
  const ownerUri = `homey:device:${sourceDeviceId}`;
  for (const capability of ['measure_power', 'energy_power']) {
    const id = `${ownerUri}:${capability}`;
    if (logs.some((entry) => isUnknownRecord(entry) && entry.id === id && entry.type === 'number'
      && entry.units === 'W' && (entry.ownerUri === ownerUri
        || (entry.ownerUri === undefined && entry.uri === `homey:log:${id}`)))) return { ownerUri, id };
  }
  return undefined;
}

function readHistoricPoint(value: unknown): { atMs: number; kw: number } | undefined {
  if (!isUnknownRecord(value) || typeof value.t !== 'string' || typeof value.v !== 'number') return undefined;
  const atMs = Date.parse(value.t);
  const kw = normalizeMeasuredPowerKw(value.v / 1000);
  return Number.isFinite(atMs) && kw !== null ? { atMs, kw } : undefined;
}

/** Use the normal sample ranking over complete recent buckets, without treating history as live draw. */
export function learnFromMeterHistory(
  raw: unknown, log: MeterPowerLog, requestedAtMs: number, sourceDeviceId: string,
): MeterHistoryPeak | undefined {
  if (!isUnknownRecord(raw) || raw.uri !== log.ownerUri || raw.id !== log.id
    || typeof raw.step !== 'number' || !Number.isFinite(raw.step) || raw.step <= 0 || raw.step > MAX_BUCKET_MS
    || !Array.isArray(raw.values) || raw.values.length > MAX_POINTS) return undefined;
  const step = raw.step;
  const points = raw.values.flatMap((value: unknown) => readHistoricPoint(value) ?? []).filter(({ atMs }) => (
    atMs >= requestedAtMs - HOUR_MS && atMs + step <= requestedAtMs
  )).sort((a, b) => a.atMs - b.atMs);
  let readings: PeakReadings | undefined;
  let previousAtMs = -Infinity;
  for (const { atMs, kw } of points) {
    if (atMs === previousAtMs) return undefined;
    previousAtMs = atMs;
    readings = recordPeakReading(readings, kw);
  }
  const kw = rankedPeakLevelKw(readings?.samplesKw ?? []);
  return kw === null ? undefined : { kw, observedAtMs: previousAtMs, sourceDeviceId };
}
