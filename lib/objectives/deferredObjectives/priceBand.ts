import type { DeferredObjectiveAllocatedBucket, DeferredObjectivePlannedBucket } from './types';

// Relative price bands: when one hour is worth shifting load to from another, and
// which hours a plan books on price. Shared by the allocator's fill order, the
// booking rule, the price-deferral fact and cold-start feasibility so "worth
// shifting load" means one thing everywhere.

// Relative price margin (~5%) below which two hours are treated as equally
// priced for fill ordering. RELATIVE (ratio-based), not a fixed offset, so it is
// invariant to the price currency — the price series carries no unit at this
// layer. The same constant gates the mid-execution deferral
// (`hasCheaperEnergyHourAhead` via `isMeaningfullyCheaper`):
// both express "a later hour must be more than ~5% cheaper to be worth shifting
// load to". Below the margin, the earlier hour wins (heat early; don't churn
// load between near-equal hours).
export const PRICE_BAND_MARGIN = 0.05;

// Width of one relative price band on the log grid `priceFillBand` quantises
// positive prices onto. Quantisation is what makes the fill order a transitive
// total order (a pairwise within-margin comparator is NOT transitive on a price
// ramp: a≈b and b≈c does not imply a≈c). The trade-off is that the grid only
// APPROXIMATES the margin at its edges: two prices within `PRICE_BAND_MARGIN` can
// fall in adjacent bands (treated as a real difference) and two prices up to
// ~2× the margin apart can share a band (treated as a tie). So the build-time
// fill order (this grid) and the live deferral (the exact `isMeaningfullyCheaper`
// ratio) can disagree near a band edge for spreads close to the margin. That is
// an accepted approximation, not a bug — both still express "~5% relative".
const PRICE_BAND_LOG_BASE = Math.log(1 + PRICE_BAND_MARGIN);

// The minimum positive price across the buckets being ordered. The band grid is
// anchored here so band membership depends only on PRICE RATIOS (`price / min`),
// never on the absolute magnitude — i.e. the same price curve produces the same
// fill order whether the feed is in øre, eurocents, or €/kWh. (A fixed grid
// anchored at `1` would, e.g., tie `100` vs `96` but split `1.00` vs `0.96` for
// the same ~4% spread — the currency-dependence this avoids.) `null` when no
// bucket carries a positive price, in which case there are no tier-1 buckets to
// rank against each other.
export const resolvePriceAnchor = (buckets: readonly { price: number | null }[]): number | null => {
  let min: number | null = null;
  for (const bucket of buckets) {
    const price = bucket.price;
    if (typeof price === 'number' && Number.isFinite(price) && price > 0 && (min === null || price < min)) {
      min = price;
    }
  }
  return min;
};

// True when `candidatePrice` is cheaper than `referencePrice` by MORE than the
// relative margin (a pure ratio, so unit-invariant). Used by the live deferral
// to decide a later hour is worth shifting load into. A non-finite or
// non-positive reference makes the ratio meaningless (you cannot be "5% cheaper
// than free/negative"), so it returns false — run now rather than defer on a
// meaningless comparison. A non-finite candidate is non-comparable → false.
export const isMeaningfullyCheaper = (
  candidatePrice: number | null,
  referencePrice: number | null,
): boolean => {
  if (typeof referencePrice !== 'number' || !Number.isFinite(referencePrice) || referencePrice <= 0) {
    return false;
  }
  if (typeof candidatePrice !== 'number' || !Number.isFinite(candidatePrice)) return false;
  return candidatePrice <= referencePrice * (1 - PRICE_BAND_MARGIN);
};

// Whether a later, non-reserve hour carrying energy is cheaper than the `reference`
// hour by more than the relative margin: the "a cheaper hour can carry this hour's
// load" fact behind price deferral. One definition for
// both clocks: the fresh planner reads it for the current hour every cycle, and the
// `:58` settle stamps it per committed hour (`stampCheaperHourAhead`) for the frozen
// read to replay.
//
// The cheaper hour must be one the plan actually carries load in, so a 0 kWh
// booking deliberately does not count. A bucket without energy (zero-capacity, or
// simply not part of the committed/expanded set) is cheap on paper but won't take
// the deferred energy:
// the committed reallocation fills the planned hours first, so releasing toward it
// would just push the load into the remaining (possibly pricier) committed hours at
// the next settle. Deadline-reserve hours are excluded so we never defer into the
// reserve. "Later" means starting at or after the reference bucket ends, which
// holds for raw price-hour starts in fractional-offset timezones too; a same-hour
// segment after the reference is either the reserve split (excluded) or a
// reservation-boundary split carrying the same price (never meaningfully cheaper).
export const hasCheaperEnergyHourAhead = (
  buckets: readonly DeferredObjectiveAllocatedBucket[],
  reference: DeferredObjectiveAllocatedBucket,
  epsilonKWh: number,
): boolean => buckets.some((bucket) => (
  !bucket.reserve
  && bucket.startMs >= reference.endMs
  && bucket.plannedUsefulEnergyKWh > epsilonKWh
  && isMeaningfullyCheaper(bucket.price, reference.price)
));

// Currency-relative fill-ordering key. Cheaper hours sort first. Returned as a
// `(tier, key)` pair compared lexicographically — a single total order, so the
// induced sort is transitive (a pairwise within-margin comparator would NOT be:
// a≈b and b≈c does not imply a≈c on a price ramp).
//
//   tier 0 — non-positive price (free / paid-to-consume): always cheaper than
//            any priced hour. `key` is the raw price so a deeper-negative hour
//            still sorts ahead of a shallow one (genuinely cheaper).
//   tier 1 — positive price: `key` is `price / anchor` quantised onto a log grid
//            of relative width `(1 + PRICE_BAND_MARGIN)`, where `anchor` is the
//            set's min positive price. Banding on the RATIO makes it
//            currency-invariant (see `resolvePriceAnchor`); two hours within ~5%
//            of each other land in the same band → they tie on price and the time
//            tiebreak (earlier first) decides.
//   tier 2 — missing/non-finite price: sorts last (fill only as a last resort).
const priceFillBand = (
  price: number | null,
  anchor: number | null,
): { tier: number; key: number } => {
  if (typeof price !== 'number' || !Number.isFinite(price)) return { tier: 2, key: 0 };
  if (price <= 0) return { tier: 0, key: price };
  // `anchor` (set min positive price) is `null` only when there are no positive
  // prices — then this is the sole tier-1 bucket and the key is irrelevant.
  const ratio = anchor === null ? 1 : price / anchor;
  return { tier: 1, key: Math.round(Math.log(ratio) / PRICE_BAND_LOG_BASE) };
};

// Cheapest-first on the currency-relative band (`priceFillBand`). Hours within
// ~`PRICE_BAND_MARGIN` of each other tie here and fall through to the time
// tiebreak (earlier first), so the allocator never churns load between
// near-equal hours for a sub-margin saving.
export const comparePrice = (
  left: { price: number | null },
  right: { price: number | null },
  anchor: number | null,
): number => {
  const a = priceFillBand(left.price, anchor);
  const b = priceFillBand(right.price, anchor);
  return a.tier - b.tier || a.key - b.key;
};

// Which hours the plan books, decided once the plan knows whether the task needs
// every hour. Booking is decided by price, not by forecast room: an hour is booked
// when it carries energy, when it is meaningfully cheaper than the dearest hour
// carrying energy (a lower price band), or when the task needs every hour (its
// shortfall is one it cannot climb or re-estimate its way out of, `needsEveryHour`).
// A booked hour the forecast left no room for carries 0 kWh: it promises nothing,
// but the task claims it and runs there if capacity turns out to be free.
//
// "Needs every hour" is the settled shortfall cause, not the floor allocation's
// leftover: a stepped thermal task's floor routinely falls short while the task
// finishes by climbing (`step_power`) or is short only by the estimate padding
// (`estimate`), and booking every hour for those would switch price optimisation
// off for most of them. Same-band hours are not booked either: on a flat price curve
// that would claim every hour of the horizon. The deadline reserve is booked only
// when it carries energy, so it stays a fallback.
export const bookBuckets = (
  buckets: readonly DeferredObjectiveAllocatedBucket[],
  needsEveryHour: boolean,
): DeferredObjectivePlannedBucket[] => {
  const anchor = resolvePriceAnchor(buckets);
  let dearest: DeferredObjectiveAllocatedBucket | null = null;
  for (const bucket of buckets) {
    if (bucket.plannedUsefulEnergyKWh <= 0) continue;
    if (dearest === null || comparePrice(bucket, dearest, anchor) > 0) dearest = bucket;
  }
  return buckets.map((bucket) => ({
    ...bucket,
    booked: bucket.plannedUsefulEnergyKWh > 0 || (!bucket.reserve && (
      needsEveryHour || (dearest !== null && comparePrice(bucket, dearest, anchor) < 0)
    )),
  }));
};
