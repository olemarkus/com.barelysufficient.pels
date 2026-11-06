import { truncateToUtcHour } from '../utils/hourBuckets';
import { addToHourlyBuckets } from './trackerBucketChanges';
import type { PowerTrackerState, RecordPowerSampleParams } from './trackerTypes';

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

/* eslint-disable functional/immutable-data -- Local accumulator avoids per-iteration copies. */
export function serializeDeviceBuckets(
  previous: PowerTrackerState['deviceBuckets'],
  incrementsByDeviceId: Map<string, Map<string, number>>,
): PowerTrackerState['deviceBuckets'] {
  let next = previous ?? {};
  for (const [deviceId, increments] of incrementsByDeviceId) {
    if (increments.size === 0) continue;
    const buckets = addToHourlyBuckets(previous?.[deviceId], increments);
    if (buckets === previous?.[deviceId]) continue;
    // eslint-disable-next-line no-restricted-syntax -- Copy once on the first change, never on later iterations.
    if (next === previous) next = { ...previous };
    // Only the new outer dictionary is edited; other devices keep their history.
    next[deviceId] = buckets;
  }
  return Object.keys(next).length > 0 ? next : undefined;
}
/* eslint-enable functional/immutable-data */

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

function accumulatePowerIfAvailable(params: {
  previousPowerW?: number;
  nextPowerW?: number;
  startTs: number;
  endTs: number;
  buckets: Map<string, number>;
}): void {
  const { previousPowerW, nextPowerW, startTs, endTs, buckets } = params;
  if (typeof previousPowerW !== 'number' || typeof nextPowerW !== 'number') return;
  calculateEnergyAcrossBoundaries({
    startTs,
    endTs,
    powerW: previousPowerW,
    buckets,
    budgets: new Map(),
    budgetKWh: null,
  });
}

/**
 * Accrues the held sample's controlled / uncontrolled / exempt / per-device
 * energy over [startTs, endTs]. Each family integrates only when both the
 * previous and next reading exist (the same both-endpoints rule as the four
 * historical `accumulatePowerIfAvailable` calls this replaces in
 * `recordPowerSample`).
 */
export function accrueTrackedSampleFamilies(params: {
  previous: TrackedSample;
  next: TrackedSample;
  startTs: number;
  endTs: number;
  controlledBuckets: Map<string, number>;
  uncontrolledBuckets: Map<string, number>;
  exemptBuckets: Map<string, number>;
  uncontrolledExemptBuckets: Map<string, number>;
  deviceBuckets: Map<string, Map<string, number>>;
}): void {
  const { previous, next, startTs, endTs } = params;
  accumulatePowerIfAvailable({
    previousPowerW: previous.controlledPowerW,
    nextPowerW: next.controlledPowerW,
    startTs,
    endTs,
    buckets: params.controlledBuckets,
  });
  accumulatePowerIfAvailable({
    previousPowerW: previous.uncontrolledPowerW,
    nextPowerW: next.uncontrolledPowerW,
    startTs,
    endTs,
    buckets: params.uncontrolledBuckets,
  });
  accumulatePowerIfAvailable({
    previousPowerW: previous.exemptPowerW,
    nextPowerW: next.exemptPowerW,
    startTs,
    endTs,
    buckets: params.exemptBuckets,
  });
  accumulatePowerIfAvailable({
    // Before this share existed, every recorded exempt watt belonged to managed load.
    previousPowerW: previous.exemptPowerW === undefined ? undefined : previous.uncontrolledExemptPowerW ?? 0,
    nextPowerW: next.exemptPowerW === undefined ? undefined : next.uncontrolledExemptPowerW ?? 0,
    startTs,
    endTs,
    buckets: params.uncontrolledExemptBuckets,
  });
  accumulateDevicePowerIfAvailable({
    previousPowerWById: previous.devicePowerWById,
    nextPowerWById: next.devicePowerWById,
    startTs,
    endTs,
    bucketsByDeviceId: params.deviceBuckets,
  });
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

/** The measured attribution families held between two whole-home readings. */
type TrackedSample = {
  controlledPowerW?: number;
  uncontrolledPowerW?: number;
  exemptPowerW?: number;
  uncontrolledExemptPowerW?: number;
  devicePowerWById?: Record<string, number>;
};

/**
 * Attribution is bounded by gross consumption, independently of net import.
 * A solar-fed appliance's exempt draw belongs to its own managed/background side.
 */
export function resolveTrackedSample(sample: RecordPowerSampleParams): TrackedSample {
  const grossPowerW = Math.max(0, sample.grossConsumptionW ?? sample.currentPowerW);
  const controlledPowerW = resolveBoundedTrackedPowerW(grossPowerW, sample.controlledPowerW);
  const uncontrolledPowerW = controlledPowerW === undefined ? undefined : Math.max(0, grossPowerW - controlledPowerW);
  return {
    controlledPowerW,
    uncontrolledPowerW,
    ...resolveExemptSample(
      grossPowerW, controlledPowerW, uncontrolledPowerW, sample.exemptPowerW, sample.uncontrolledExemptPowerW,
    ),
    devicePowerWById: normalizeDevicePowerWById(sample.currentDevicePowerWById),
  };
}

function resolveBoundedTrackedPowerW(currentPowerW: number, trackedPowerW?: number): number | undefined {
  if (typeof trackedPowerW !== 'number' || !Number.isFinite(trackedPowerW)) return undefined;
  return Math.max(0, Math.min(trackedPowerW, currentPowerW));
}

/** Bounds the portions separately so a clipped background reading cannot become managed energy. */
function resolveExemptSample(
  grossPowerW: number,
  controlledPowerW: number | undefined,
  uncontrolledPowerW: number | undefined,
  exemptPowerW: number | undefined,
  uncontrolledExemptPowerW: number | undefined,
): Pick<TrackedSample, 'exemptPowerW' | 'uncontrolledExemptPowerW'> {
  if (typeof exemptPowerW !== 'number' || !Number.isFinite(exemptPowerW)) return {};
  const total = Math.max(0, exemptPowerW);
  // Split device evidence before capping to the meter: an oversized background
  // reading must not consume the managed device's exemption.
  const background = Math.max(0, Math.min(total, uncontrolledExemptPowerW ?? 0));
  const boundedBackground = Math.min(background, uncontrolledPowerW ?? grossPowerW);
  const managed = Math.min(total - background, controlledPowerW ?? grossPowerW);
  return {
    exemptPowerW: Math.min(grossPowerW, managed + boundedBackground),
    uncontrolledExemptPowerW: boundedBackground,
  };
}

type ExemptFamilyAggregate = {
  buckets?: Record<string, number>;
  dailyTotals: Record<string, number>;
  hourlyAverages: Record<string, { sum: number; count: number }>;
};

type ExemptAggregateForType = (
  buckets?: Record<string, number>,
  dailyTotals?: Record<string, number>,
  hourlyAverages?: Record<string, { sum: number; count: number }>,
) => ExemptFamilyAggregate;

/** Preserve absence on pre-attribution histories; otherwise fold the share with the owning retention policy. */
export function buildUncontrolledExemptAggregatePatch(
  state: PowerTrackerState,
  aggregateForType: ExemptAggregateForType,
): Partial<PowerTrackerState> {
  if (!state.uncontrolledExemptBuckets
    && !state.uncontrolledExemptDailyTotals
    && !state.uncontrolledExemptHourlyAverages) {
    return {};
  }
  const aggregate = aggregateForType(
    state.uncontrolledExemptBuckets, state.uncontrolledExemptDailyTotals, state.uncontrolledExemptHourlyAverages,
  );
  return {
    uncontrolledExemptBuckets: aggregate.buckets,
    uncontrolledExemptDailyTotals: aggregate.dailyTotals,
    uncontrolledExemptHourlyAverages: aggregate.hourlyAverages,
  };
}
