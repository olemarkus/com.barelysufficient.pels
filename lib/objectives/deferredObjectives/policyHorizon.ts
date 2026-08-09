import type { DailyBudgetDayPayload, DailyBudgetUiPayload } from '../../../packages/contracts/src/dailyBudgetTypes';
import type { PriceHorizonEntry } from '../../../packages/planner-types/src/priceHorizon';
import type { DeferredObjectiveHorizonBucket } from './types';

export type { PriceHorizonEntry };

export type DeferredObjectivePriorityReservation = {
  deviceId: string;
  // Stable claim identity used only to detect topology changes. Useful energy
  // and trimmed interval bounds may drift while the same source bucket remains
  // claimed, so neither belongs in the coordination signature.
  topologyKey: string;
  startsAtMs: number;
  admissionPowerKw: number;
  plannedKWh: number;
  exemptFromBudget: boolean;
  energySegments: Array<{ startMs: number; endMs: number; plannedKWh: number }>;
};

export type DeferredObjectivePolicyHorizonUnavailableReason =
  | 'objective_price_feature_disabled'
  | 'objective_missing_price_horizon';

export type DeferredObjectivePolicyHorizonResult =
  | {
    buckets: DeferredObjectiveHorizonBucket[];
    horizonBucketCount: number;
    reasonCode: null;
  }
  | {
    buckets: [];
    horizonBucketCount: 0;
    reasonCode: DeferredObjectivePolicyHorizonUnavailableReason;
  };

// Per-bucket capacity starts from the household budget after forecast background
// use. The diagnostics coordinator visits smart tasks in priority order and
// subtracts the exact physical and energy claims already made by higher-priority
// tasks before this source bucket is handed to the allocator.
type PolicyBucketSource = {
  id: string;
  sourceBucketId: string;
  startMs: number;
  endMs: number;
  price: number;
  backgroundKWh: number | null;
  grossBackgroundKWh: number | null;
  // The hour's OWN share of the daily budget available to managed load, read
  // straight from the budget layer's `plannedControlledKWh`. `null` means the
  // snapshot had no matching bucket (no daily-budget cap for this hour).
  //
  // Deliberately NOT derived by differencing `allowedCumKWh`. That curve is
  // clamped at the day total (`buildAllowedCumKWh`), so differencing it returns
  // an hour's share only until the cumulative meets the cap and zero for every
  // hour after — which silently unbooks the tail of any day whose plan sums past
  // its budget. The soft daily budget does exactly that by design: an hour's
  // overspend must not penalise later hours, so the per-hour plan legitimately
  // sums above `dailyBudgetKWh`. See `notes/safe-pace-two-constraints.md` for
  // the axis this quantity lives on.
  controlledShareKWh: number | null;
};

const HOUR_MS = 60 * 60 * 1000;

// Far edge of the AVAILABLE price data, in epoch ms: the end of the last
// published price hour the producer handed us (`max(entry.startMs) + 1h`).
// `buildPriceHorizonFromCombined` already windowed the entries to `[nowMs,
// deadlineAtMs)` and dropped hours with no published price, so this is the real
// extent of usable Nordpool data for the deadline — NOT re-clamped to the
// allocator's deadline-trimmed buckets (which saturate at the deadline once a
// plan is committed). The active-plan recorder uses it as the "prices were valid
// through" watermark to tell a genuine price-publication advance (`prices_revised`)
// from an internal schedule reshuffle (`schedule_revised`). Returns `null` when
// no priced hour is available (empty horizon), so the recorder can carry the
// previous watermark forward rather than resetting it.
export const resolvePriceHorizonAvailableUpToMs = (
  priceHorizon: readonly PriceHorizonEntry[],
): number | null => {
  let latestStartMs: number | null = null;
  for (const entry of priceHorizon) {
    if (!Number.isFinite(entry.startMs)) continue;
    if (latestStartMs === null || entry.startMs > latestStartMs) latestStartMs = entry.startMs;
  }
  return latestStartMs === null ? null : latestStartMs + HOUR_MS;
};

export const buildDeferredObjectivePolicyHorizon = (params: {
  nowMs: number;
  deadlineAtMs: number;
  priceOptimizationEnabled: boolean;
  // Price + grid source for the allocation horizon, sourced directly from the
  // price layer (`buildPriceHorizonFromCombined`). The base buckets (id /
  // startMs / endMs / price) are built from this — NOT the daily-budget
  // snapshot, which is now only the budget overlay below.
  priceHorizon: PriceHorizonEntry[];
  // OPTIONAL budget overlay. When a day-bucket matches a price-horizon hour
  // (its `startUtc` floors to the same epoch hour), its `controlledShareKWh` /
  // `backgroundKWh` / `grossBackgroundKWh` are overlaid onto that bucket.
  // When absent, the bucket runs with no daily-budget cap and the per-hour
  // hard cap becomes the only constraint.
  dailyBudgetSnapshot: DailyBudgetUiPayload | null;
  // When true (an at-risk smart task that was granted the "exempt from budget"
  // rescue permission), the per-bucket daily-budget cap is lifted so the planner
  // may schedule into otherwise budget-exhausted buckets. This relaxes only the
  // soft daily-budget throttle; physical capacity stays enforced downstream at
  // admission and the capacity guard.
  exemptFromBudget?: boolean;
  // Configured hard cap in kW. When provided alongside the daily-budget snapshot's
  // gross background forecast, each bucket gets a `reservedHeadroomKw` forecast
  // (`hardCapKw − grossBackgroundKw`) that a fully-reserved smart task can use to
  // promote its committed floor step. Optional: missing → no forecast → the planner
  // stays on the min-step floor.
  hardCapKw?: number | null;
  // Hourly claims already made by higher-priority smart tasks. Physical power
  // is always deducted; planned energy is deducted only for non-exempt tasks.
  higherPriorityReservations?: readonly DeferredObjectivePriorityReservation[];
}): DeferredObjectivePolicyHorizonResult => {
  const {
    nowMs,
    deadlineAtMs,
    priceOptimizationEnabled,
    priceHorizon,
    dailyBudgetSnapshot,
    exemptFromBudget = false,
    hardCapKw = null,
    higherPriorityReservations = [],
  } = params;
  if (!priceOptimizationEnabled) {
    return unavailable('objective_price_feature_disabled');
  }
  const sourceBuckets = collectPriceBuckets({
    nowMs,
    deadlineAtMs,
    priceHorizon,
    dailyBudgetSnapshot,
  });
  if (!sourceBuckets || sourceBuckets.length === 0) {
    return unavailable('objective_missing_price_horizon');
  }
  return {
    buckets: mapPolicyBuckets(
      splitPolicyBucketsAtReservationBoundaries(sourceBuckets, higherPriorityReservations),
      exemptFromBudget,
      hardCapKw,
      higherPriorityReservations,
    ),
    horizonBucketCount: sourceBuckets.length,
    reasonCode: null,
  };
};

// Per-bucket Grid price (`total`) keyed by bucket id (the bucket's ISO start
// string, which is also `DeferredObjectivePlannedBucket.sourceBucketId`), read
// from the daily-budget snapshot's money series (`buckets.price`). Deliberately
// split from what the allocation ranks on: the planner schedules against the
// planning-price horizon (`budgetPrice ?? total` via
// `buildPriceHorizonFromCombined`), while this cost map stays on the money
// price — so for a prosumer the preview's price curve/cost can diverge from the
// planner's ranking (TODO-tracked with the preview migration). Returns an empty
// map when the snapshot has no usable price buckets. Used by the plan-preview
// composition, which needs the raw per-bucket price to cost the plan.
// TODO: preview reader still sources price from the daily-budget snapshot pending the preview migration.
export const buildDeferredObjectivePolicyBucketPrices = (
  dailyBudgetSnapshot: DailyBudgetUiPayload | null,
): Map<string, number> => {
  if (!dailyBudgetSnapshot) return new Map();
  const prices = new Map<string, number>();
  for (const bucket of collectSnapshotPriceBuckets(dailyBudgetSnapshot)) {
    prices.set(bucket.id, bucket.price);
  }
  return prices;
};

// One hour on the preview price curve: an EPOCH-hour-aligned UTC start and that
// hour's per-kWh spot price, or `null` when no price is published for the hour.
export type DeferredObjectivePolicyWindowPrice = {
  startMs: number;
  price: number | null;
};

// Epoch-hour floor — the SAME basis `buildHoursFromHorizonPlan` floors scheduled
// hours to (activePlanSchedule.ts). Keeping both on this basis is what lets the
// widget join `priceSeries` against `scheduledHours` by `startsAtMs`; a
// fractional-offset timezone (UTC+5:30/+5:45) starts its local-day buckets at
// :30/:45 past the UTC hour, so emitting the raw bucket start would never match
// the floored scheduled hours and the chart would highlight nothing.
const PRICE_WINDOW_HOUR_MS = 60 * 60 * 1000;
const floorToHourMs = (ms: number): number => Math.floor(ms / PRICE_WINDOW_HOUR_MS) * PRICE_WINDOW_HOUR_MS;

// Hourly spot prices across the preview window `[nowMs, deadlineAtMs)`, as a
// DENSE, ascending, epoch-hour-floored series — the SAME snapshot price buckets
// the policy horizon and cost estimate consume, sliced to the window. Powers the
// create-task preview chart's price curve. Imposes NO horizon-coverage
// requirement (a partial curve is still informative). An interior hour with no
// published price is emitted as a `null`-price slot (so the chart breaks the line
// across the gap and the time axis stays true), NOT dropped — dropping would
// collapse the array indices the chart lays out by and skew the x-axis. Returns
// an empty array when no priced buckets fall in the window.
// TODO: preview reader still sources price from the daily-budget snapshot pending the preview migration.
export const buildDeferredObjectivePolicyWindowPrices = (
  dailyBudgetSnapshot: DailyBudgetUiPayload | null,
  nowMs: number,
  deadlineAtMs: number,
): DeferredObjectivePolicyWindowPrice[] => {
  if (!dailyBudgetSnapshot) return [];
  // Buckets arrive ascending by start (today then tomorrow, each in hour order).
  const priceByHour = new Map<number, number>();
  for (const bucket of collectSnapshotPriceBuckets(dailyBudgetSnapshot)) {
    if (bucket.endMs <= nowMs || bucket.startMs >= deadlineAtMs) continue;
    // Clip the start to `nowMs` for the in-progress bucket — the SAME basis
    // `buildHoursFromHorizonPlan` floors (the planner normalises a straddling
    // bucket to `max(startMs, nowMs)`). Without the clip, in a fractional-offset
    // timezone the current bucket keys to the PREVIOUS epoch hour and the
    // current scheduled hour would never highlight.
    const hour = floorToHourMs(Math.max(bucket.startMs, nowMs));
    // First-write wins: in a fractional-offset zone the clipped in-progress
    // bucket and the next bucket can floor to the SAME epoch hour. Keep the
    // earlier (current) one — the bucket the planner is actually drawing from at
    // `nowMs` — so the hour shows the price being paid now, not the next bucket's.
    if (!priceByHour.has(hour)) priceByHour.set(hour, bucket.price);
  }
  if (priceByHour.size === 0) return [];
  const hours = [...priceByHour.keys()].sort((left, right) => left - right);
  const series: DeferredObjectivePolicyWindowPrice[] = [];
  for (let hour = hours[0]; hour <= hours[hours.length - 1]; hour += PRICE_WINDOW_HOUR_MS) {
    series.push({ startMs: hour, price: priceByHour.get(hour) ?? null });
  }
  return series;
};

const unavailable = (
  reasonCode: DeferredObjectivePolicyHorizonUnavailableReason,
): DeferredObjectivePolicyHorizonResult => ({
  buckets: [],
  horizonBucketCount: 0,
  reasonCode,
});

// Budget overlay fields for a single horizon hour, looked up from the
// daily-budget snapshot. `null` means there was no matching snapshot bucket.
type BudgetOverlay = {
  backgroundKWh: number | null;
  grossBackgroundKWh: number | null;
  controlledShareKWh: number | null;
};

// No matching snapshot bucket: run with no daily-budget cap. `backgroundKWh = 0`
// (NOT null) is REQUIRED so `resolveReservedHeadroomKw` returns `hardCapKw` (the
// per-hour hard cap becomes the constraint); `controlledShareKWh = null` keeps
// `resolveMaxUsefulEnergyKWh` null (no daily-budget cap).
const NO_BUDGET_OVERLAY: BudgetOverlay = {
  backgroundKWh: 0,
  grossBackgroundKWh: 0,
  controlledShareKWh: null,
};

// Build the allocation base buckets from the PRICE-LAYER horizon (price + grid)
// and overlay the OPTIONAL daily-budget snapshot for the budget fields only.
// Returns null when the price horizon is empty or does not cover
// `[nowMs, deadlineAtMs)`.
const collectPriceBuckets = (params: {
  nowMs: number;
  deadlineAtMs: number;
  priceHorizon: PriceHorizonEntry[];
  dailyBudgetSnapshot: DailyBudgetUiPayload | null;
}): PolicyBucketSource[] | null => {
  const {
    nowMs,
    deadlineAtMs,
    priceHorizon,
    dailyBudgetSnapshot,
  } = params;
  const budgetByHour = buildBudgetOverlayByHour(dailyBudgetSnapshot);
  const allBuckets = priceHorizon.flatMap((entry) => {
    // `entry.startMs` is the RAW price-hour start instant (NOT clipped to `nowMs`,
    // NOT floored). Keeping it raw is what preserves byte-identical behavior with
    // the pre-decouple snapshot grid for ALL timezones: the horizon planner trims
    // the current bucket to `nowMs` for allocation, while the bucket's own
    // `endMs - startMs` feeds `resolveReservedHeadroomKw` / `resolveMaxUsefulEnergyKWh`
    // at the FULL-hour duration (clipping would inflate the uncontrolled-kW term),
    // and the raw instant keeps fractional-offset (UTC+5:30) grids phase-aligned
    // with the daily-budget overlay. The epoch-hour floor is only the join key.
    const startMs = entry.startMs;
    // Each priced hour spans exactly ONE hour — do NOT stretch a bucket to the
    // next entry's start. A sparse feed (e.g. 10:00 + 12:00 but no 11:00) must
    // leave a real gap so `coversHorizon` reports `objective_missing_price_horizon`
    // instead of silently bridging the missing hour at the prior hour's price.
    const endMs = startMs + HOUR_MS;
    // Window filter mirrors the legacy `endMs > nowMs && startMs < deadlineAtMs`.
    if (endMs <= nowMs || startMs >= deadlineAtMs) return [];
    const hourKey = Math.floor(startMs / HOUR_MS) * HOUR_MS;
    const overlay = budgetByHour.get(hourKey) ?? NO_BUDGET_OVERLAY;
    return [{
      // Id is the raw price-hour-start ISO — for whole-hour-offset timezones this
      // equals the daily-budget snapshot's `startUtc` id, and for fractional
      // offsets it carries the same `:30`/`:45` instant, preserving the
      // downstream `sourceBucketId` cost join in both cases.
      id: new Date(startMs).toISOString(),
      sourceBucketId: new Date(startMs).toISOString(),
      startMs,
      endMs,
      price: entry.price,
      backgroundKWh: overlay.backgroundKWh,
      grossBackgroundKWh: overlay.grossBackgroundKWh,
      controlledShareKWh: overlay.controlledShareKWh,
    }];
  });
  if (allBuckets.length === 0) return null;
  if (!coversHorizon({ buckets: allBuckets, nowMs, deadlineAtMs })) return null;
  return allBuckets;
};

// Index the daily-budget snapshot's day-buckets by epoch-hour-floored start so
// the price-horizon buckets can overlay the budget fields. First-write wins on a
// duplicate hour (matches the price-horizon dedupe direction).
const buildBudgetOverlayByHour = (
  snapshot: DailyBudgetUiPayload | null,
): Map<number, BudgetOverlay> => {
  const byHour = new Map<number, BudgetOverlay>();
  if (!snapshot) return byHour;
  for (const dateKey of [snapshot.todayKey, snapshot.tomorrowKey]) {
    if (!dateKey) continue;
    const day = snapshot.days[dateKey];
    if (!day) continue;
    for (const overlay of collectDayBudgetOverlays(day)) {
      const hour = Math.floor(overlay.startMs / HOUR_MS) * HOUR_MS;
      if (!byHour.has(hour)) {
        byHour.set(hour, {
          backgroundKWh: overlay.backgroundKWh,
          grossBackgroundKWh: overlay.grossBackgroundKWh,
          controlledShareKWh: overlay.controlledShareKWh,
        });
      }
    }
  }
  return byHour;
};

const collectDayBudgetOverlays = (
  day: DailyBudgetDayPayload,
): Array<BudgetOverlay & { startMs: number }> => {
  // A DISABLED daily budget imposes no soft cap. The disabled-state snapshot
  // still carries an all-zero `plannedControlledKWh` array, which would read as a
  // controlled share of 0 — clamping every smart task's allocation to zero useful
  // energy (`cannot_meet`) whenever the user has daily budget off. Contribute NO
  // overlay so each bucket falls through to `NO_BUDGET_OVERLAY` and the per-hour
  // hard cap becomes the only constraint, matching the "no daily budget ⇒ hard cap
  // only" contract.
  if (!day.budget.enabled) return [];
  const starts = day.buckets.startUtc;
  if (!Array.isArray(starts)) return [];
  const plannedControlledKWh = Array.isArray(day.buckets.plannedControlledKWh)
    ? day.buckets.plannedControlledKWh
    : [];
  const plannedUncontrolledKWh = Array.isArray(day.buckets.plannedUncontrolledKWh)
    ? day.buckets.plannedUncontrolledKWh
    : [];
  const plannedGrossUncontrolledKWh = day.buckets.plannedGrossUncontrolledKWh;
  return starts.flatMap((startIso, index) => {
    const startMs = new Date(startIso).getTime();
    if (!Number.isFinite(startMs)) return [];
    const backgroundKWh = finiteOrNull(plannedUncontrolledKWh[index]);
    return [{
      startMs,
      backgroundKWh,
      grossBackgroundKWh: finiteOrNull(plannedGrossUncontrolledKWh?.[index]) ?? backgroundKWh,
      controlledShareKWh: nonNegativeOrNull(plannedControlledKWh[index]),
    }];
  });
};

// Preview-only snapshot price buckets (id/price/budget keyed off the snapshot's
// own `startUtc`). The ALLOCATION path no longer uses this — it reads the price
// layer via `buildPriceHorizonFromCombined`. See the preview-reader TODOs.
const collectSnapshotPriceBuckets = (snapshot: DailyBudgetUiPayload): PolicyBucketSource[] => (
  [snapshot.todayKey, snapshot.tomorrowKey]
    .flatMap((dateKey) => {
      if (!dateKey) return [];
      const day = snapshot.days[dateKey];
      return day ? collectDayPriceBuckets(day) : [];
    })
);

const collectDayPriceBuckets = (day: DailyBudgetDayPayload): PolicyBucketSource[] => {
  const starts = day.buckets.startUtc;
  const prices = day.buckets.price;
  if (!Array.isArray(starts) || !Array.isArray(prices)) return [];
  const plannedControlledKWh = Array.isArray(day.buckets.plannedControlledKWh)
    ? day.buckets.plannedControlledKWh
    : [];
  const plannedUncontrolledKWh = Array.isArray(day.buckets.plannedUncontrolledKWh)
    ? day.buckets.plannedUncontrolledKWh
    : [];
  const plannedGrossUncontrolledKWh = day.buckets.plannedGrossUncontrolledKWh;
  const budgetEnabled = day.budget.enabled;
  return starts.flatMap((startIso, index) => {
    const startMs = new Date(startIso).getTime();
    const endMs = resolveBucketEndMs(starts, index);
    const price = prices[index];
    if (
      !Number.isFinite(startMs)
      || !Number.isFinite(endMs)
      || endMs <= startMs
      || typeof price !== 'number'
      || !Number.isFinite(price)
    ) {
      return [];
    }
    const backgroundKWh = finiteOrNull(plannedUncontrolledKWh[index]);
    return [{
      id: startIso,
      sourceBucketId: startIso,
      startMs,
      endMs,
      price,
      backgroundKWh,
      grossBackgroundKWh: finiteOrNull(plannedGrossUncontrolledKWh?.[index]) ?? backgroundKWh,
      // A disabled budget imposes no soft cap — mirrors the `!day.budget.enabled`
      // early return in `collectDayBudgetOverlays`.
      controlledShareKWh: budgetEnabled ? nonNegativeOrNull(plannedControlledKWh[index]) : null,
    }];
  });
};

const finiteOrNull = (value: number | undefined): number | null => (
  typeof value === 'number' && Number.isFinite(value) ? value : null
);

// A controlled share is an energy quantity: negative is malformed, not a valid
// "no room this hour" decision. Resolve it to `null` (no daily-budget cap for
// this bucket) rather than letting it read as a 0 cap, which would silently
// make the hour unbookable on junk data — the same failure this PR fixes, from
// a different direction. Mirrors `normalizeReservedHeadroomKw` in
// `bucketAllocation.ts`, which resolves a negative headroom forecast to
// "unavailable" at the same boundary. A genuine zero share is preserved: it is
// the budget layer's real answer that this hour has nothing for managed load.
const nonNegativeOrNull = (value: number | undefined): number | null => {
  const finite = finiteOrNull(value);
  return finite === null || finite < 0 ? null : finite;
};

const resolveBucketEndMs = (starts: string[], index: number): number => {
  const nextStart = starts[index + 1];
  if (typeof nextStart === 'string') {
    return new Date(nextStart).getTime();
  }
  return new Date(starts[index]).getTime() + 60 * 60 * 1000;
};

const coversHorizon = (params: {
  buckets: PolicyBucketSource[];
  nowMs: number;
  deadlineAtMs: number;
}): boolean => {
  const { buckets, nowMs, deadlineAtMs } = params;
  let coveredUntilMs = nowMs;
  for (const bucket of buckets) {
    if (bucket.startMs > coveredUntilMs) return false;
    if (bucket.endMs > coveredUntilMs) coveredUntilMs = bucket.endMs;
    if (coveredUntilMs >= deadlineAtMs) return true;
  }
  return false;
};

const mapPolicyBuckets = (
  buckets: PolicyBucketSource[],
  exemptFromBudget: boolean,
  hardCapKw: number | null,
  higherPriorityReservations: readonly DeferredObjectivePriorityReservation[],
): DeferredObjectiveHorizonBucket[] => {
  return buckets.map((bucket) => {
    const higher = resolveReservationsForBucket(bucket, higherPriorityReservations);
    const cap = resolveMaxUsefulEnergyKWh(bucket, exemptFromBudget);
    const reservedHeadroomKw = resolveReservedHeadroomKw(
      bucket,
      hardCapKw,
      higher?.admissionPowerKw ?? 0,
    );
    return {
      id: bucket.id,
      sourceBucketId: bucket.sourceBucketId,
      startMs: bucket.startMs,
      endMs: bucket.endMs,
      // Raw price is the sole price signal. The allocator fills hours
      // cheapest-first by comparing these relatively (currency-invariant band)
      // and the live deferral compares them by ratio. `buildPriceHorizonFromCombined`
      // already filters out non-finite prices, so every source bucket has one.
      price: bucket.price,
      ...(cap !== null ? { maxUsefulEnergyKWh: cap } : {}),
      ...(reservedHeadroomKw !== null ? { reservedHeadroomKw } : {}),
      ...(higher && higher.energySegments.length > 0
        ? { higherPriorityEnergyReservations: higher.energySegments }
        : {}),
    };
  });
};

const prorateNullableEnergy = (
  value: number | null,
  fraction: number,
): number | null => value === null ? null : value * fraction;

// A source price hour is not necessarily a single physical-capacity interval:
// a higher-priority task may reserve different steps for different parts of
// that hour. Split at every exact claim boundary before deriving kW headroom so
// a lower-priority task can use the genuinely-free remainder instead of seeing
// the highest step flattened across the whole hour. Energy-valued forecast
// fields are prorated; price and the stable source identity remain unchanged.
const splitPolicyBucketsAtReservationBoundaries = (
  buckets: readonly PolicyBucketSource[],
  reservations: readonly DeferredObjectivePriorityReservation[],
): PolicyBucketSource[] => buckets.flatMap((bucket) => {
  const boundaries = new Set<number>([bucket.startMs, bucket.endMs]);
  for (const reservation of reservations) {
    for (const segment of reservation.energySegments) {
      if (!overlapsBucket(bucket, segment)) continue;
      if (segment.startMs > bucket.startMs && segment.startMs < bucket.endMs) {
        boundaries.add(segment.startMs);
      }
      if (segment.endMs > bucket.startMs && segment.endMs < bucket.endMs) {
        boundaries.add(segment.endMs);
      }
    }
  }
  const ordered = [...boundaries].sort((left, right) => left - right);
  if (ordered.length === 2) return [bucket];
  const originalDurationMs = bucket.endMs - bucket.startMs;
  return ordered.slice(0, -1).map((startMs, index) => {
    const endMs = ordered[index + 1]!;
    const fraction = (endMs - startMs) / originalDurationMs;
    return {
      ...bucket,
      id: `${bucket.id}:${startMs}-${endMs}`,
      startMs,
      endMs,
      backgroundKWh: prorateNullableEnergy(bucket.backgroundKWh, fraction),
      grossBackgroundKWh: prorateNullableEnergy(bucket.grossBackgroundKWh, fraction),
      controlledShareKWh: prorateNullableEnergy(bucket.controlledShareKWh, fraction),
    };
  });
});

type HourReservation = {
  admissionPowerKw: number;
  energySegments: Array<{ startMs: number; endMs: number; plannedKWh: number }>;
};

const overlapsBucket = (
  bucket: Pick<PolicyBucketSource, 'startMs' | 'endMs'>,
  segment: { startMs: number; endMs: number },
): boolean => segment.startMs < bucket.endMs && segment.endMs > bucket.startMs;

const resolveReservationsForBucket = (
  bucket: PolicyBucketSource,
  reservations: readonly DeferredObjectivePriorityReservation[],
): HourReservation | undefined => {
  const admissionByDeviceId = new Map<string, number>();
  const energySegments: HourReservation['energySegments'] = [];
  for (const reservation of reservations) {
    const overlappingSegments = reservation.energySegments
      .filter((segment) => overlapsBucket(bucket, segment));
    if (overlappingSegments.length === 0) continue;
    admissionByDeviceId.set(
      reservation.deviceId,
      Math.max(admissionByDeviceId.get(reservation.deviceId) ?? 0, reservation.admissionPowerKw),
    );
    if (!reservation.exemptFromBudget) {
      for (const segment of overlappingSegments) energySegments.push(segment);
    }
  }
  if (admissionByDeviceId.size === 0) return undefined;
  return {
    admissionPowerKw: [...admissionByDeviceId.values()].reduce((sum, powerKw) => sum + powerKw, 0),
    energySegments,
  };
};

// Residual physical room after gross background and every higher-priority
// smart-task step reservation. Clamped at zero; null means the physical inputs
// were unavailable and the planner falls back to its existing live guards.
const resolveReservedHeadroomKw = (
  bucket: PolicyBucketSource,
  hardCapKw: number | null,
  higherPriorityAdmissionPowerKw: number,
): number | null => {
  if (hardCapKw === null || !Number.isFinite(hardCapKw) || hardCapKw <= 0) return null;
  const physicalBackgroundKWh = bucket.grossBackgroundKWh ?? bucket.backgroundKWh;
  if (physicalBackgroundKWh === null) return null;
  const durationHours = (bucket.endMs - bucket.startMs) / (60 * 60 * 1000);
  if (durationHours <= 0) return null;
  const uncontrolledKw = Math.max(0, physicalBackgroundKWh / durationHours);
  return Math.max(0, hardCapKw - uncontrolledKw - Math.max(0, higherPriorityAdmissionPowerKw));
};

const resolveMaxUsefulEnergyKWh = (
  bucket: PolicyBucketSource,
  exemptFromBudget: boolean,
): number | null => {
  // "Exempt from budget" lifts the per-bucket daily-budget cap entirely; the
  // bucket falls back to the device's step capacity in allocation, and physical
  // limits are enforced downstream (admission / capacity guard).
  if (exemptFromBudget) return null;
  // The hour's own controlled share, as the budget layer allocated it.
  //
  // Numerically this equals `plannedKWh - plannedUncontrolledKWh`: both
  // producers conserve the split exactly (`buildPlanBreakdown` derives
  // uncontrolled from a share then floors the remainder; `buildPlannedSplit`
  // returns `plannedUncontrolled = planned - plannedControlled`). We read the
  // field rather than re-subtract because the split is the budget layer's to
  // define — including the controlled floor and uncontrolled reserve that shape
  // it — and a consumer recomputing it would fork that definition the next time
  // it changes.
  return bucket.controlledShareKWh;
};
