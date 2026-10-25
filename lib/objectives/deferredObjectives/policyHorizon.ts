import type { DailyBudgetDayPayload, DailyBudgetUiPayload } from '../../../packages/contracts/src/dailyBudgetTypes';
import type { PriceHorizonEntry } from '../../../packages/planner-types/src/priceHorizon';
import type { DeferredObjectiveHorizonBucket, DeferredObjectivePowerLimit } from './types';
import type { PowerLimitSettings } from '../../../packages/contracts/src/capacitySettings';
import { gridImportTargetKw } from '../../../packages/shared-domain/src/settings/powerLimits';
import { resolvePlanningCeilingKw } from '../../power/capacityModel';

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

// Last published period end, before deadline clipping. The recorder uses this
// watermark to distinguish newly available prices from an internal replan.
export const resolvePriceHorizonAvailableUpToMs = (
  priceHorizon: readonly PriceHorizonEntry[],
): number | null => {
  return priceHorizon.length === 0 ? null : Math.max(...priceHorizon.map((entry) => entry.endMs));
};

// What a smart task's policy horizon is built from: its window, the price and
// budget layers, the admissible rate, and the bookings ranked above it. The fresh
// path keeps it so the budget-exempt rescue can rebuild the same horizon with the
// cap lifted.
export type DeferredObjectivePolicyHorizonInputs = {
  nowMs: number;
  deadlineAtMs: number;
  priceOptimizationEnabled: boolean;
  // Price + grid source for the allocation horizon, sourced directly from the
  // price layer (`buildPriceHorizonFromCombined`). The base buckets (id /
  // startMs / endMs / price) are built from this — NOT the daily-budget
  // snapshot, which is now only the budget overlay below.
  priceHorizon: PriceHorizonEntry[];
  // OPTIONAL hourly budget overlay. The source interval is split at allowance
  // boundaries and receives its overlap share of controlled/background energy.
  // When absent, the bucket runs with no daily-budget cap and the per-hour
  // planning ceiling becomes the only constraint.
  dailyBudgetSnapshot: DailyBudgetUiPayload | null;
  // When true (an at-risk smart task that was granted the "exempt from budget"
  // rescue permission), the per-bucket daily-budget cap is lifted so the planner
  // may schedule into otherwise budget-exhausted buckets. This relaxes only the
  // soft daily-budget throttle; physical capacity stays enforced downstream at
  // admission and the capacity guard.
  exemptFromBudget: boolean;
  // The house's power-limit settings, from which the horizon resolves its
  // planning ceiling (`resolvePlanningCeilingKw`, `lib/power`): the lower enabled
  // limit's working rate (hard cap minus safety margin, grid import target),
  // which bounds each bucket's reserved headroom. With only Capacity limit on it
  // is the rate the capacity guard will admit (`limitKw - marginKw`). With no
  // power limit enabled there is no ceiling, and no bucket carries a reserved
  // headroom. The planner reads the same settings as a whole
  // (`resolveDeferredObjectivePowerLimit`).
  powerLimits: PowerLimitSettings;
  // Whether the home has solar production (a role-detected PV device). Export can
  // lift live grid headroom past the grid import target, so a PV home's plan is
  // not cut at that target (`resolveDeferredObjectivePowerLimit`).
  hasSolarProduction: boolean;
  // Hourly claims already made by higher-priority smart tasks. Physical power
  // is always deducted; planned energy is deducted only for non-exempt tasks.
  higherPriorityReservations: readonly DeferredObjectivePriorityReservation[];
  // Maximum step power of higher-ranked devices running outside smart-task
  // control. They have no timed booking, so reserve their possible draw across
  // the horizon without inventing a useful-energy claim for them.
  higherPriorityUnbookedPowerKw: number;
};

/**
 * How the house's enabled power limits bound a smart task's horizon plan
 * (`DeferredObjectivePowerLimit`): unlimited with no power limit enabled, and
 * otherwise limited. The grid import target is the admission ceiling only while
 * Grid import limit is on in a home with no solar production: live admission
 * spends signed net headroom, so solar export lets a rung above the target run,
 * and with no per-hour solar forecast the plan keeps the whole ladder there and
 * leaves the rung to live admission. A capacity-only home is limited with no
 * admission ceiling, which plans exactly as before.
 */
export const resolveDeferredObjectivePowerLimit = (
  powerLimits: PowerLimitSettings,
  hasSolarProduction: boolean,
): DeferredObjectivePowerLimit => {
  if (resolvePlanningCeilingKw(powerLimits) === null) return { kind: 'unlimited' };
  const { gridImportLimitKw } = powerLimits;
  const admissionCeilingKw = gridImportLimitKw === null || hasSolarProduction
    ? null
    : gridImportTargetKw(gridImportLimitKw);
  return { kind: 'limited', admissionCeilingKw };
};

export const buildDeferredObjectivePolicyHorizon = (
  params: DeferredObjectivePolicyHorizonInputs,
): DeferredObjectivePolicyHorizonResult => {
  const {
    nowMs,
    deadlineAtMs,
    priceOptimizationEnabled,
    priceHorizon,
    dailyBudgetSnapshot,
    exemptFromBudget,
    powerLimits,
    higherPriorityReservations,
    higherPriorityUnbookedPowerKw,
  } = params;
  if (!priceOptimizationEnabled) {
    return unavailable('objective_price_feature_disabled');
  }
  const sourceBuckets = collectPriceBuckets(nowMs, deadlineAtMs, priceHorizon, dailyBudgetSnapshot);
  if (!sourceBuckets || sourceBuckets.length === 0) {
    return unavailable('objective_missing_price_horizon');
  }
  return {
    buckets: mapPolicyBuckets(
      splitPolicyBucketsAtReservationBoundaries(sourceBuckets, higherPriorityReservations),
      exemptFromBudget,
      resolvePlanningCeilingKw(powerLimits),
      higherPriorityReservations,
      higherPriorityUnbookedPowerKw,
    ),
    horizonBucketCount: sourceBuckets.length,
    reasonCode: null,
  };
};

// Import prices belong to the price owner; daily-budget prices are an hourly
// projection and cannot price an individual quarter's delivery.
export const buildDeferredObjectivePolicyBucketPrices = (
  priceHorizon: readonly PriceHorizonEntry[],
): Map<string, number> => new Map(priceHorizon.map((period) => [
  new Date(period.startMs).toISOString(), period.moneyPrice,
]));

export type DeferredObjectivePolicyWindowPrice = {
  startMs: number;
  endMs: number;
  price: number | null;
};

// Preserve explicit gaps and elapsed-time geometry, including non-hour grids.
export const buildDeferredObjectivePolicyWindowPrices = (
  priceHorizon: readonly PriceHorizonEntry[],
  nowMs: number,
  deadlineAtMs: number,
): DeferredObjectivePolicyWindowPrice[] => {
  // Append to a fresh result while walking the source timeline once.
  /* eslint-disable functional/immutable-data */
  const series: DeferredObjectivePolicyWindowPrice[] = [];
  let coveredUntilMs = nowMs;
  for (const entry of priceHorizon) {
    const startMs = Math.max(nowMs, entry.startMs);
    const endMs = Math.min(deadlineAtMs, entry.endMs);
    if (endMs <= startMs) continue;
    if (startMs > coveredUntilMs) series.push({ startMs: coveredUntilMs, endMs: startMs, price: null });
    series.push({ startMs, endMs, price: entry.price });
    coveredUntilMs = endMs;
  }
  if (series.length > 0 && coveredUntilMs < deadlineAtMs) {
    series.push({ startMs: coveredUntilMs, endMs: deadlineAtMs, price: null });
  }
  /* eslint-enable functional/immutable-data */
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
// (NOT null) is REQUIRED so `resolveReservedHeadroomKw` returns `planningCeilingKw` (the
// per-hour planning ceiling becomes the constraint); `controlledShareKWh = null` keeps
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
const collectPriceBuckets = (
  nowMs: number,
  deadlineAtMs: number,
  priceHorizon: PriceHorizonEntry[],
  dailyBudgetSnapshot: DailyBudgetUiPayload | null,
): PolicyBucketSource[] | null => {
  const overlays = collectBudgetOverlays(dailyBudgetSnapshot);
  const allBuckets = priceHorizon.flatMap((entry) => {
    if (entry.endMs <= nowMs || entry.startMs >= deadlineAtMs) return [];
    const boundaries = [...new Set([
      entry.startMs, entry.endMs,
      ...overlays.flatMap((overlay) => [overlay.startMs, overlay.startMs + HOUR_MS])
        .filter((boundary) => boundary > entry.startMs && boundary < entry.endMs),
    ])].sort((left, right) => left - right);
    return boundaries.slice(0, -1).flatMap((startMs, index): PolicyBucketSource[] => {
      const endMs = boundaries[index + 1];
      if (endMs === undefined) return [];
      const overlay = overlays.find((hour) => hour.startMs <= startMs && startMs < hour.startMs + HOUR_MS)
        ?? NO_BUDGET_OVERLAY;
      const fraction = (endMs - startMs) / HOUR_MS;
      return [{
        id: new Date(startMs).toISOString(),
        sourceBucketId: new Date(entry.startMs).toISOString(),
        startMs, endMs, price: entry.price,
        backgroundKWh: overlay.backgroundKWh === null ? null : overlay.backgroundKWh * fraction,
        grossBackgroundKWh: overlay.grossBackgroundKWh === null ? null : overlay.grossBackgroundKWh * fraction,
        controlledShareKWh: overlay.controlledShareKWh === null ? null : overlay.controlledShareKWh * fraction,
      }];
    });
  });
  if (allBuckets.length === 0 || !coversHorizon(allBuckets, nowMs, deadlineAtMs)) return null;
  return allBuckets;
};

// Daily-budget learning stays hourly. Split each native price interval where an
// hourly allowance changes and distribute that allowance by elapsed duration.
const collectBudgetOverlays = (
  snapshot: DailyBudgetUiPayload | null,
): Array<BudgetOverlay & { startMs: number }> => {
  if (!snapshot) return [];
  const byStart = new Map<number, BudgetOverlay & { startMs: number }>();
  for (const dateKey of [snapshot.todayKey, snapshot.tomorrowKey]) {
    const day = dateKey ? snapshot.days[dateKey] : undefined;
    if (!day) continue;
    for (const overlay of collectDayBudgetOverlays(day)) {
      if (!byStart.has(overlay.startMs)) byStart.set(overlay.startMs, overlay);
    }
  }
  return [...byStart.values()];
};

const collectDayBudgetOverlays = (
  day: DailyBudgetDayPayload,
): Array<BudgetOverlay & { startMs: number }> => {
  // A DISABLED daily budget imposes no soft cap. The disabled-state snapshot
  // still carries an all-zero `plannedControlledKWh` array, which would read as a
  // controlled share of 0 — clamping every smart task's allocation to zero useful
  // energy (`cannot_meet`) whenever the user has daily budget off. Contribute NO
  // overlay so each bucket falls through to `NO_BUDGET_OVERLAY` and the per-hour
  // planning ceiling becomes the only constraint, matching the "no daily budget ⇒
  // power limits only" contract.
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

const coversHorizon = (buckets: PolicyBucketSource[], nowMs: number, deadlineAtMs: number): boolean => {
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
  planningCeilingKw: number | null,
  higherPriorityReservations: readonly DeferredObjectivePriorityReservation[],
  higherPriorityUnbookedPowerKw: number,
): DeferredObjectiveHorizonBucket[] => {
  return buckets.map((bucket) => {
    const higher = resolveReservationsForBucket(bucket, higherPriorityReservations);
    const higherPriorityAdmissionPowerKw = higherPriorityUnbookedPowerKw + (higher?.admissionPowerKw ?? 0);
    const cap = resolveMaxUsefulEnergyKWh(bucket, exemptFromBudget);
    const reservedHeadroomKw = resolveReservedHeadroomKw(
      bucket,
      planningCeilingKw,
      higherPriorityAdmissionPowerKw,
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
      ...(higherPriorityAdmissionPowerKw > 0
        ? { higherPriorityAdmissionPowerKw }
        : {}),
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
// Consecutive boundaries pair up into `[start, end)` parts; the final boundary
// is an end only, so it opens nothing.
/* eslint-disable functional/immutable-data -- Local accumulator avoids per-iteration copies. */
const boundaryParts = (ordered: readonly number[]): Array<{ startMs: number; endMs: number }> => {
  const parts: Array<{ startMs: number; endMs: number }> = [];
  for (const [index, startMs] of ordered.entries()) {
    const endMs = ordered[index + 1];
    if (endMs === undefined) break;
    parts.push({ startMs, endMs });
  }
  return parts;
};
/* eslint-enable functional/immutable-data */

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
  return boundaryParts(ordered).map(({ startMs, endMs }) => {
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

/* eslint-disable functional/immutable-data -- Local accumulator avoids per-iteration copies. */
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
/* eslint-enable functional/immutable-data */

// Residual physical room after gross background and every higher-priority
// smart-task step reservation. Clamped at zero; null means the physical inputs
// were unavailable, or no power limit is enabled so no ceiling exists to reserve
// room under, and the planner falls back to its existing live guards.
const resolveReservedHeadroomKw = (
  bucket: PolicyBucketSource,
  planningCeilingKw: number | null,
  higherPriorityAdmissionPowerKw: number,
): number | null => {
  // No ceiling is genuine absence, not a large rate: the key is omitted, which
  // `resolveBucketStepCapacityKWh` and the step probes read as "no forecast".
  if (planningCeilingKw === null) return null;
  // A pace of zero is reachable and is REPORTED, not suppressed: `modeCards.ts`
  // validates a Flow-set hard cap as `> 0` without comparing it to the persisted
  // margin, so `limitKw` below `marginKw` floors the rate at 0. Returning `null`
  // there would omit the key, and `resolveBucketStepCapacityKWh` reads an omitted
  // headroom as `POSITIVE_INFINITY` — turning "the guard admits nothing" into
  // "unlimited", the fabricated stand-in the root AGENTS.md forbids. Zero is a
  // measurement; it travels as zero.
  const physicalBackgroundKWh = bucket.grossBackgroundKWh ?? bucket.backgroundKWh;
  if (physicalBackgroundKWh === null) return null;
  const durationHours = (bucket.endMs - bucket.startMs) / (60 * 60 * 1000);
  if (durationHours <= 0) return null;
  const uncontrolledKw = Math.max(0, physicalBackgroundKWh / durationHours);
  return Math.max(0, planningCeilingKw - uncontrolledKw - Math.max(0, higherPriorityAdmissionPowerKw));
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
