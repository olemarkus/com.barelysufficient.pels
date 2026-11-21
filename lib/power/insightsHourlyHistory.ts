import { isFiniteNumber } from '../../packages/shared-domain/src/numberGuards';
import { isUnknownRecord } from '../../packages/shared-domain/src/recordGuards';
import { getLogger } from '../logging/logger';
import type { PowerTrackerState } from './trackerTypes';

const HOUR_MS = 3_600_000;
const MIN_OVERLAP = 32;
// A single gap can remove two neighboring shift comparisons. A window edge can remove one more.
const MIN_SHIFT_OVERLAP = MIN_OVERLAP - 3;

export type HourlyInsightsLog = { ownerUri: string; id: string };

/** Resolve the selected meter's public Insights logs at the transport boundary. */
export function readHourlyInsightsLogs(raw: unknown, meterDeviceId: string): {
  power: HourlyInsightsLog; exported: HourlyInsightsLog;
} {
  if (!Array.isArray(raw) && !isUnknownRecord(raw)) throw new Error('Insights log information is unavailable.');
  const entries: readonly unknown[] = Array.isArray(raw) ? raw : Object.values(raw);
  const ownerUri = `homey:device:${meterDeviceId}`;
  const read = (capability: string, units: string): HourlyInsightsLog => {
    const id = `${ownerUri}:${capability}`;
    const log = entries.find((value) => isUnknownRecord(value) && value.id === id);
    if (!isUnknownRecord(log) || log.type !== 'number' || log.units !== units
      || (log.ownerUri !== ownerUri && !(log.ownerUri === undefined && log.uri === `homey:log:${id}`))) {
      throw new Error('The selected meter does not provide the required Insights history.');
    }
    return { ownerUri, id };
  };
  return { power: read('energy_power', 'W'), exported: read('meter_power.exported', 'kWh') };
}

function readHour(timestamp: unknown, timestamps: Set<number>): number | undefined {
  const hour = typeof timestamp === 'string' ? Date.parse(timestamp) : NaN;
  if (!Number.isFinite(hour) || hour % HOUR_MS !== 0) return undefined;
  if (timestamps.has(hour)) throw new Error('Insights hourly details contain a duplicate timestamp.');
  timestamps.add(hour);
  return hour;
}

function readHourlySeries(
  raw: unknown, log: HourlyInsightsLog, kind: 'net_power' | 'export_counter',
): Map<number, number> {
  if (!isUnknownRecord(raw) || raw.uri !== log.ownerUri || raw.id !== log.id
    || raw.step !== HOUR_MS || !Array.isArray(raw.values)) {
    throw new Error('Insights did not return hourly details for the selected meter.');
  }
  const points = new Map<number, number>();
  const timestamps = new Set<number>();
  const logger = getLogger('power/history-recovery');
  for (const [index, value] of raw.values.entries()) {
    if (!isUnknownRecord(value)) {
      logger.warn({ event: 'power_history_recovery_point_skipped', logId: log.id, index, reason: 'non_record' });
      continue;
    }
    const hour = readHour(value.t, timestamps);
    if (hour === undefined) {
      logger.warn({ event: 'power_history_recovery_point_skipped', logId: log.id, index, reason: 'invalid_timestamp' });
      continue;
    }
    if (value.v === null) continue;
    if (!isFiniteNumber(value.v) || (kind === 'export_counter' && value.v < 0)) {
      logger.warn({
        event: 'power_history_recovery_point_skipped', logId: log.id, index,
        hour: new Date(hour).toISOString(), reason: 'invalid_value',
      });
      continue;
    }
    points.set(hour, value.v);
  }
  return points;
}

/** W averages become kWh only for genuine complete one-hour intervals. */
export function resolveHourlyInsightsHistory(
  powerRaw: unknown, exportRaw: unknown, logs: { power: HourlyInsightsLog; exported: HourlyInsightsLog },
  tracker: PowerTrackerState, nowMs: number,
): Readonly<Record<string, number>> {
  const power = readHourlySeries(powerRaw, logs.power, 'net_power');
  const exported = readHourlySeries(exportRaw, logs.exported, 'export_counter');
  const currentHour = Math.floor(nowMs / HOUR_MS) * HOUR_MS;
  const imported = recoverImportHours(power, exported, currentHour);
  if (imported.size === 0) throw new Error('No completed hourly Insights readings can be recovered.');
  assertMatchingHistory(imported, tracker);
  return Object.fromEntries([...imported].map(([hour, kwh]) => [new Date(hour).toISOString(), kwh]));
}

function recoverImportHours(
  power: ReadonlyMap<number, number>, exported: ReadonlyMap<number, number>, currentHour: number,
): Map<number, number> {
  const imported = new Map<number, number>();
  const exportReadings = [...exported].sort(([a], [b]) => a - b);
  const powerReadings = [...power].sort(([a], [b]) => a - b);
  let exportIndex = 0;
  for (const [hour, watts] of powerReadings) {
    if (hour >= currentHour) break;
    if (watts < 0) {
      imported.set(hour, 0);
      continue;
    }
    let atOrAfter = exportReadings[exportIndex];
    while (atOrAfter && atOrAfter[0] < hour) {
      exportIndex += 1;
      atOrAfter = exportReadings[exportIndex];
    }
    const before = exportReadings[exportIndex - 1];
    const at = atOrAfter?.[0] === hour ? atOrAfter : undefined;
    const after = at ? exportReadings[exportIndex + 1] : atOrAfter;
    // Counter averages bracket the hour. A flat counter across those buckets
    // allows net power to represent import, even with a missing counter sample.
    if (before && after && before[1] === after[1] && (!at || at[1] === before[1])) {
      imported.set(hour, watts / 1000);
    }
  }
  return imported;
}

function assertMatchingHistory(imported: ReadonlyMap<number, number>, tracker: PowerTrackerState): void {
  const retained = Object.entries(tracker.buckets ?? {}).sort(([a], [b]) => a.localeCompare(b));
  const earliest = retained[0]?.[0];
  const overlap = retained.flatMap(([key, kwh]) => {
    const hour = Date.parse(key);
    const recovered = imported.get(hour);
    return key !== earliest && kwh >= 0.1 && Number.isFinite(kwh) && recovered !== undefined && recovered > 0
      && !(tracker.unreliablePeriods ?? []).some((period) => period.start < hour + HOUR_MS && period.end > hour)
      ? [[hour, kwh, recovered] as const] : [];
  });
  if (overlap.length < MIN_OVERLAP) {
    throw new Error('At least 32 comparable recorded hours are needed to verify Insights history.');
  }
  const comparable = overlap.filter(([hour]) => imported.has(hour - HOUR_MS) && imported.has(hour + HOUR_MS));
  if (comparable.length < MIN_SHIFT_OVERLAP) {
    throw new Error('Insights does not have enough adjacent hours to verify timestamps.');
  }
  const shiftError = (shift: number): number => comparable.reduce((sum, [hour, kwh]) => (
    sum + Math.abs((imported.get(hour + shift) as number) - kwh)
  ), 0);
  const ratios = overlap.map(([, kwh, recovered]) => recovered / kwh).sort((a, b) => a - b);
  const middle = Math.floor(ratios.length / 2);
  const lower = ratios[middle - 1];
  const upper = ratios[middle];
  if (lower === undefined || upper === undefined) throw new Error('Insights overlap could not be verified.');
  const median = ratios.length % 2 === 0 ? (lower + upper) / 2 : upper;
  const matching = overlap.filter(([, kwh, recovered]) => (
    Math.abs(recovered - kwh) <= Math.max(0.1, kwh * 0.05)
  )).length;
  const error = shiftError(0);
  if (matching / overlap.length < 0.9 || median < 0.95 || median > 1.05
    || error >= shiftError(-HOUR_MS) * 0.9 || error >= shiftError(HOUR_MS) * 0.9) {
    throw new Error('Insights hourly details do not match recorded usage closely enough.');
  }
}
