import { truncateToUtcHour } from '../utils/dateUtils';

export const calculateEnergyAcrossBoundaries = (params: {
  startTs: number;
  endTs: number;
  powerW: number;
  buckets: Map<string, number>;
  budgets: Map<string, number>;
  budgetKWh: number | null;
}) => {
  const { startTs, endTs, powerW, buckets, budgets, budgetKWh } = params;
  let currentTs = startTs;
  let remainingMs = endTs - startTs;

  while (remainingMs > 0) {
    const hourStart = truncateToUtcHour(currentTs);
    const hourEnd = hourStart + 60 * 60 * 1000;
    const segmentMs = Math.min(remainingMs, hourEnd - currentTs);
    const energyKWh = (powerW / 1000) * (segmentMs / 3600000);
    const bucketKey = new Date(hourStart).toISOString();

    buckets.set(bucketKey, (buckets.get(bucketKey) || 0) + energyKWh);
    if (budgetKWh !== null) {
      budgets.set(bucketKey, budgetKWh);
    }

    remainingMs -= segmentMs;
    currentTs += segmentMs;
  }
};

export function normalizeDevicePowerWById(
  devicePowerWById: Record<string, number> | undefined,
): Record<string, number> | undefined {
  if (!devicePowerWById) return undefined;
  const entries = Object.entries(devicePowerWById).flatMap(([deviceId, powerW]) => (
    deviceId && typeof powerW === 'number' && Number.isFinite(powerW)
      ? [[deviceId, Math.max(0, powerW)] as const]
      : []
  ));
  return Object.fromEntries(entries);
}

export function serializeDeviceBuckets(
  bucketsByDeviceId: Map<string, Map<string, number>>,
): Record<string, Record<string, number>> | undefined {
  const entries = Array.from(bucketsByDeviceId.entries()).flatMap(([deviceId, buckets]) => {
    const retained = Object.fromEntries(buckets);
    return Object.keys(retained).length > 0 ? [[deviceId, retained] as const] : [];
  });
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

export function pruneHourlyBucketsOnly(params: {
  buckets?: Record<string, number>;
  hourlyThreshold: number;
}): Map<string, number> | undefined {
  const { buckets, hourlyThreshold } = params;
  if (!buckets) return undefined;
  const nextBuckets = new Map<string, number>();
  for (const [isoKey, kWh] of Object.entries(buckets)) {
    const timestamp = new Date(isoKey).getTime();
    if (!Number.isNaN(timestamp) && timestamp >= hourlyThreshold) {
      nextBuckets.set(isoKey, kWh);
    }
  }
  return nextBuckets;
}

// Floor each aged hour before folding it into the per-day total: a legacy solar-export hour
// (persisted before the write-side clamp) carries negative kWh that a read-side
// `Math.max(0, dailyTotal)` can't repair once it has been summed into the day.
export function foldAgedHourIntoDay(
  dayHourBuckets: Map<string, Map<number, number>>,
  nextDailyTotals: Map<string, number>,
  dateKey: string,
  hourOfDay: number,
  kWh: number,
): void {
  const agedKWh = Math.max(0, kWh);
  const hours = dayHourBuckets.get(dateKey) ?? new Map<number, number>();
  hours.set(hourOfDay, Math.max(0, hours.get(hourOfDay) ?? 0) + agedKWh);
  dayHourBuckets.set(dateKey, hours);
  // Floor the existing per-day baseline too: an earlier prune may have stored a negative
  // daily total for a partially-aged solar-export day before the clamp landed.
  nextDailyTotals.set(dateKey, Math.max(0, nextDailyTotals.get(dateKey) || 0) + agedKWh);
}

export function accumulateDevicePowerIfAvailable(params: {
  previousPowerWById?: Record<string, number>;
  nextPowerWById?: Record<string, number>;
  startTs: number;
  endTs: number;
  bucketsByDeviceId: Map<string, Map<string, number>>;
}): void {
  const { previousPowerWById, nextPowerWById, startTs, endTs, bucketsByDeviceId } = params;
  if (!previousPowerWById || !nextPowerWById) return;
  for (const [deviceId, previousPowerW] of Object.entries(previousPowerWById)) {
    if (typeof previousPowerW !== 'number' || !Number.isFinite(previousPowerW)) continue;
    if (!Object.prototype.hasOwnProperty.call(nextPowerWById, deviceId)) continue;
    let deviceBuckets = bucketsByDeviceId.get(deviceId);
    if (!deviceBuckets) {
      deviceBuckets = new Map<string, number>();
      bucketsByDeviceId.set(deviceId, deviceBuckets);
    }
    calculateEnergyAcrossBoundaries({
      startTs,
      endTs,
      powerW: Math.max(0, previousPowerW),
      buckets: deviceBuckets,
      budgets: new Map(),
      budgetKWh: null,
    });
  }
}
