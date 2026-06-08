// Nice-number Y axis for the plan_budget chart. The old axis sliced the raw data
// peak (`maxPlan × 1.08`) into a FIXED 4 intervals and rounded each label to one
// decimal, so a label was only "round" when the peak happened to be ~a multiple
// of 0.4 (the 1.2 mock is the lucky case) — real peaks produced non-round labels
// like 0 / 1.2 / 2.3 / 3.5 / 4.6, and a tall tile kept the same 5 lines, leaving
// big unlabelled gaps once the plot body started filling the card.
//
// Instead, pick a NICE step (1 / 2 / 2.5 / 5 × 10ⁿ) and make every kWh gridline a
// multiple of it: multiples of a fixed step are round by definition and distinct
// by definition, so "no non-round labels" and "no repeated labels" both hold for
// free at every tile size. The interval COUNT scales with the plot height (a
// taller tile gets more gridlines, keeping spacing roughly constant). The price
// axis shares those gridlines (one set of horizontal lines), so it can't pick its
// own count; its integer labels are the value landing at each shared gridline,
// with a guard that skips a label identical to the previous (lower) one — the
// ticks are built bottom→top and price rises monotonically, so a near-flat day's
// rounding collisions are always adjacent. The gridline stays, the duplicate
// price number is dropped.
//
// Pure math, no DOM — browser-safe and unit-tested directly (see
// test/unit/planPriceWidgetBrowser.test.ts).

// The 1/2/2.5/5 mantissa progression: the conventional "nice" axis steps. Scaled
// by a power of ten, these are the only step sizes the axis ever uses, so every
// label is a clean multiple.
const NICE_MANTISSAS = [1, 2, 2.5, 5];

// Headroom above the data peak so the tallest bar doesn't touch the axis top, and
// a floor so a near-zero day still renders a sane 0..1 axis rather than collapsing.
const PEAK_HEADROOM = 1.08;
const MIN_KWH_MAX = 1;

// One gridline interval per ~this many viewBox units of plot height. The viewBox
// maps 1:1 onto the tile, so a taller tile has more units and earns more
// intervals; clamped so a short tile keeps the familiar density and a very tall
// tile doesn't over-rule the axis.
const INTERVAL_TARGET_UNITS = 120;
const MIN_INTERVALS = 4;
const MAX_INTERVALS = 8;

const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value));

// Upper boundaries (geometric midpoints between adjacent mantissas) for rounding a
// normalized step to the NEAREST nice mantissa — e.g. 3.0 sits between 2.5 and 5
// but below √12.5 ≈ 3.54, so it rounds to 2.5, not up to 5. Rounding to nearest
// (rather than always up) keeps the gridline count close to the height target
// instead of undershooting it.
const MANTISSA_UPPER_BOUNDS = [1.414, 2.236, 3.536, 7.071]; // → 1, 2, 2.5, 5

// The nice step (1/2/2.5/5 × 10ⁿ) nearest to `raw`.
const nearestNiceStep = (raw: number): number => {
  if (!Number.isFinite(raw) || raw <= 0) return NICE_MANTISSAS[0];
  const decade = 10 ** Math.floor(Math.log10(raw));
  const norm = raw / decade; // in [1, 10)
  for (let i = 0; i < MANTISSA_UPPER_BOUNDS.length; i += 1) {
    if (norm < MANTISSA_UPPER_BOUNDS[i]) return NICE_MANTISSAS[i] * decade;
  }
  return 10 * decade; // norm in [7.07, 10) → next decade's `1`
};

// Format a kWh tick: the value is always a multiple of a nice step, so two
// decimals reproduce it exactly; strip trailing zeros so 0.50 → "0.5", 1.00 → "1".
const formatKwhTick = (value: number): string => String(Number(value.toFixed(2)));

// Price ticks are whole kr/øre.
const formatPriceTick = (value: number): string => String(Math.round(value));

export type YAxisTick = {
  // Fraction up the plot (0 = bottom axis, 1 = top), shared by both axes.
  ratio: number;
  // Left (kWh) label — always present, always round and distinct.
  kwhLabel: string;
  // Right (price) label — null when it would repeat the integer below it, or when
  // there's no price data, so no duplicate number is ever drawn.
  priceLabel: string | null;
};

export type YAxis = {
  // The nice axis ceiling the bars scale against (>= the headroomed data peak).
  kwhMax: number;
  ticks: YAxisTick[];
};

export type YAxisInput = {
  peakKwh: number;
  // Plot body height in viewBox units (drives how many gridlines fit).
  plotHeight: number;
  priceMin: number;
  priceMax: number;
  hasPriceData: boolean;
};

// Resolve the shared gridlines: a nice-number kWh axis whose interval count tracks
// the plot height, plus the price label that lands on each gridline (deduped).
export const resolveYAxis = ({
  peakKwh, plotHeight, priceMin, priceMax, hasPriceData,
}: YAxisInput): YAxis => {
  const rawMax = Math.max(MIN_KWH_MAX, peakKwh * PEAK_HEADROOM);
  const desiredIntervals = clamp(
    Math.round(plotHeight / INTERVAL_TARGET_UNITS),
    MIN_INTERVALS,
    MAX_INTERVALS,
  );
  // Nearest nice step for the target interval count, then round the axis ceiling
  // up to a whole number of steps. The nearest-nice step can overshoot the target
  // (a small step → many intervals); widen it until the count fits MAX_INTERVALS.
  let kwhStep = nearestNiceStep(rawMax / desiredIntervals);
  let kwhMax = Math.ceil(rawMax / kwhStep - 1e-9) * kwhStep;
  let count = Math.max(1, Math.round(kwhMax / kwhStep));
  while (count > MAX_INTERVALS) {
    kwhStep = nearestNiceStep(kwhStep * 1.5); // jump to the next nice mantissa up
    kwhMax = Math.ceil(rawMax / kwhStep - 1e-9) * kwhStep;
    count = Math.max(1, Math.round(kwhMax / kwhStep));
  }
  // Mirror the clamp the chart plots the price series/dots against
  // (`Math.max(1, priceBounds.max - priceBounds.min)` in chart.ts), so a sub-1
  // price span labels the same scale the dots are positioned on — otherwise the
  // top gridline label and the max-price dot would disagree.
  const priceSpan = Math.max(1, priceMax - priceMin);

  const ticks: YAxisTick[] = [];
  let lastPriceLabel: string | null = null;
  for (let index = 0; index <= count; index += 1) {
    const ratio = index / count;
    let priceLabel: string | null = null;
    if (hasPriceData) {
      const candidate = formatPriceTick(priceMin + (priceSpan * ratio));
      // Drop a price label identical to the previous (lower) one (near-flat day)
      // so the same integer never appears on two gridlines; the gridline stays.
      priceLabel = candidate === lastPriceLabel ? null : candidate;
      if (priceLabel !== null) lastPriceLabel = priceLabel;
    }
    ticks.push({ ratio, kwhLabel: formatKwhTick(kwhStep * index), priceLabel });
  }

  return { kwhMax, ticks };
};
