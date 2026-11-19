import { isFiniteNumber } from '../../packages/shared-domain/src/numberGuards';
import { isUnknownRecord } from '../../packages/shared-domain/src/recordGuards';
import type { PowerTrackerState } from './trackerTypes';

const HOUR_MS = 3_600_000;
const MIN_OVERLAP = 32;

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

function readHourlySeries(raw: unknown, log: HourlyInsightsLog): Map<number, number> {
  if (!isUnknownRecord(raw) || raw.uri !== log.ownerUri || raw.id !== log.id
    || raw.step !== HOUR_MS || !Array.isArray(raw.values)) {
    throw new Error('Insights did not return hourly details for the selected meter.');
  }
  const points = new Map<number, number>();
  const timestamps = new Set<number>();
  for (const value of raw.values) {
    if (!isUnknownRecord(value) || typeof value.t !== 'string') {
      throw new Error('Insights hourly details contain an invalid reading.');
    }
    const hour = Date.parse(value.t);
    if (!Number.isFinite(hour) || hour % HOUR_MS !== 0 || timestamps.has(hour)) {
      throw new Error('Insights hourly details contain an invalid timestamp.');
    }
    timestamps.add(hour);
    if (value.v === null) continue;
    if (!isFiniteNumber(value.v) || value.v < 0) {
      throw new Error('Insights hourly details contain an invalid reading.');
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
  const power = readHourlySeries(powerRaw, logs.power);
  const exported = readHourlySeries(exportRaw, logs.exported);
  const currentHour = Math.floor(nowMs / HOUR_MS) * HOUR_MS;
  const closed = [...power.keys()].filter((hour) => hour < currentHour).sort((a, b) => a - b);
  const first = closed[0];
  const last = closed[closed.length - 1];
  if (first === undefined || last === undefined) throw new Error('No completed hourly Insights history is available.');
  const exportBaseline = exported.get(first);
  if (exportBaseline === undefined) throw new Error('Export history does not cover the recovery period.');
  for (let hour = first; hour <= last; hour += HOUR_MS) {
    if (exported.get(hour) !== exportBaseline) {
      throw new Error('Hourly net power cannot recover import usage during changes in export history.');
    }
  }
  assertMatchingHistory(power, tracker, currentHour);
  return Object.fromEntries(closed.map((hour) => [new Date(hour).toISOString(), (power.get(hour) as number) / 1000]));
}

function assertMatchingHistory(
  power: ReadonlyMap<number, number>, tracker: PowerTrackerState, currentHour: number,
): void {
  const retained = Object.entries(tracker.buckets ?? {}).sort(([a], [b]) => a.localeCompare(b));
  const earliest = retained[0]?.[0];
  const overlap = retained.filter(([key, kwh]) => {
    const hour = Date.parse(key);
    return key !== earliest && hour < currentHour && kwh >= 0.1 && Number.isFinite(kwh)
      && power.has(hour)
      && !(tracker.unreliablePeriods ?? []).some((period) => period.start < hour + HOUR_MS && period.end > hour);
  });
  if (overlap.length < MIN_OVERLAP) {
    throw new Error('At least 32 comparable recorded hours are needed to verify Insights history.');
  }
  const meanError = (shift: number): number => {
    const comparable = overlap.filter(([key]) => power.has(Date.parse(key) + shift));
    if (comparable.length < MIN_OVERLAP - 1) {
      throw new Error('Insights does not have enough adjacent hours to verify timestamps.');
    }
    return comparable.reduce((sum, [key, kwh]) => (
      sum + Math.abs((power.get(Date.parse(key) + shift) as number) / 1000 - kwh)
    ), 0) / comparable.length;
  };
  const ratios = overlap.map(([key, kwh]) => (power.get(Date.parse(key)) as number) / 1000 / kwh).sort((a, b) => a - b);
  const middle = Math.floor(ratios.length / 2);
  const lower = ratios[middle - 1];
  const upper = ratios[middle];
  if (lower === undefined || upper === undefined) throw new Error('Insights overlap could not be verified.');
  const median = ratios.length % 2 === 0 ? (lower + upper) / 2 : upper;
  const matching = overlap.filter(([key, kwh]) => (
    Math.abs((power.get(Date.parse(key)) as number) / 1000 - kwh) <= Math.max(0.1, kwh * 0.05)
  )).length;
  if (matching / overlap.length < 0.9 || median < 0.95 || median > 1.05
    || meanError(0) >= meanError(-HOUR_MS) * 0.9 || meanError(0) >= meanError(HOUR_MS) * 0.9) {
    throw new Error('Insights hourly details do not match recorded usage closely enough.');
  }
}
