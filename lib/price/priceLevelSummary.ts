import type { PriceTimeline } from '../../packages/contracts/src/priceTimeline';
import type { PriceLevelSummary, PriceThresholdSuggestion } from '../../packages/contracts/src/settingsUiApi';
import type { PriceLevelBand } from './priceLevelUtils';
import { calculateThresholds, getPriceLevelFlags } from './priceMath';

// Below this the prices are effectively flat: a lower threshold would mark
// differences of a few percent, which no device trades comfort for. It is also
// the threshold field's own minimum, so a suggestion is always one it accepts.
const MIN_SUGGESTED_PERCENT = 5;

const NO_SUGGESTION: PriceThresholdSuggestion = { kind: 'none' };

type SuggestionSeries = {
  prices: number[];
  average: number;
  /** The highest price among the cheapest quarter of the periods. */
  cheapUpTo: number;
};

/** The classifier's answer for one price at a band, over the series average. */
const flagsAt = (series: SuggestionSeries, price: number, band: PriceLevelBand) => getPriceLevelFlags({
  price,
  avgPrice: series.average,
  thresholds: calculateThresholds(series.average, band.thresholdPercent),
  minDiff: band.minDiff,
});

const countsAsCheap = (series: SuggestionSeries, band: PriceLevelBand): boolean => (
  flagsAt(series, series.cheapUpTo, band).isCheap
);

// The suggestion only targets cheap: a band that would also mark a known price
// expensive would trade comfort for the difference, so it is not offered.
const marksAnyExpensive = (series: SuggestionSeries, band: PriceLevelBand): boolean => (
  series.prices.some((price) => flagsAt(series, price, band).isExpensive)
);

const offerIfOnlyCheap = (
  series: SuggestionSeries,
  band: PriceLevelBand,
  suggestion: PriceThresholdSuggestion,
): PriceThresholdSuggestion => (marksAnyExpensive(series, band) ? NO_SUGGESTION : suggestion);

/**
 * The largest whole percent at which the cheapest quarter counts as cheap at
 * the owner's minimum difference. The classifier has the last word: a percent
 * on the exact boundary can miss by a rounding error, so step down until the
 * price really counts as cheap.
 */
const suggestLowerThreshold = (series: SuggestionSeries, band: PriceLevelBand): PriceThresholdSuggestion => {
  let percent = Math.floor((1 - series.cheapUpTo / series.average) * 100 + 1e-9);
  while (percent >= MIN_SUGGESTED_PERCENT && !countsAsCheap(series, { ...band, thresholdPercent: percent })) {
    percent -= 1;
  }
  if (percent < MIN_SUGGESTED_PERCENT) return NO_SUGGESTION;
  return offerIfOnlyCheap(
    series,
    { ...band, thresholdPercent: percent },
    { kind: 'lower_threshold', percent, cheapUpTo: series.cheapUpTo },
  );
};

// Whole units on a source priced in øre or cents; on one priced in a currency
// (0.41 EUR) a whole unit would be no minimum at all, so the step is the
// largest power of ten that still fits the gap (0.093 EUR → 0.01).
const minDifferenceStep = (gap: number): number => (gap >= 1 ? 1 : 10 ** Math.floor(Math.log10(gap)));

/**
 * The largest minimum difference, in whole steps, at which the cheapest
 * quarter counts as cheap at the owner's percent, stepped down until the
 * classifier agrees, as for the percent.
 */
const suggestLowerMinDifference = (series: SuggestionSeries, band: PriceLevelBand): PriceThresholdSuggestion => {
  const gap = series.average - series.cheapUpTo;
  if (gap <= 0) return NO_SUGGESTION;
  const step = minDifferenceStep(gap);
  const decimals = Math.max(0, -Math.floor(Math.log10(step)));
  const atSteps = (steps: number): number => Number((steps * step).toFixed(decimals));
  let steps = Math.floor(gap / step + 1e-9);
  while (steps > 0 && !countsAsCheap(series, { ...band, minDiff: atSteps(steps) })) steps -= 1;
  const minDifference = atSteps(steps);
  if (!countsAsCheap(series, { ...band, minDiff: minDifference })) return NO_SUGGESTION;
  return offerIfOnlyCheap(
    series,
    { ...band, minDiff: minDifference },
    { kind: 'lower_min_difference', minDifference, cheapUpTo: series.cheapUpTo },
  );
};

/**
 * One setting change at which the cheapest quarter of the known prices counts
 * as cheap, for a series where nothing is cheap or expensive at the owner's
 * band. Under Norgespris, for example, the fixed electricity price leaves only
 * the grid tariff to move the price, and the default 25 % finds no cheap hour;
 * with a minimum difference set, that can be what keeps the nights normal.
 *
 * A cheap price must pass both the percent and the minimum difference
 * (`getPriceLevelFlags`), so the suggestion changes whichever one keeps the
 * cheapest quarter normal. When both do, it suggests nothing: the form offers
 * one change behind one button, and neither change alone would make those
 * prices cheap, so either would promise what it does not deliver.
 */
export const suggestPriceThreshold = (
  timeline: Pick<PriceTimeline, 'periods' | 'lines'>,
  band: PriceLevelBand,
): PriceThresholdSuggestion => {
  const { periods, lines } = timeline;
  if (periods.length === 0 || periods.some((period) => period.level !== 'normal')) return NO_SUGGESTION;
  if (lines.average <= 0) return NO_SUGGESTION;
  const prices = periods.map((period) => period.importPrice);
  const sorted = [...prices].sort((a, b) => a - b);
  const cheapUpTo = sorted[Math.max(1, Math.floor(sorted.length / 4)) - 1];
  if (cheapUpTo === undefined) return NO_SUGGESTION;
  const series: SuggestionSeries = { prices, average: lines.average, cheapUpTo };
  const percentBlocks = !countsAsCheap(series, { ...band, minDiff: 0 });
  const minDifferenceBlocks = lines.average - cheapUpTo < band.minDiff;
  if (percentBlocks && minDifferenceBlocks) return NO_SUGGESTION;
  if (percentBlocks) return suggestLowerThreshold(series, band);
  if (minDifferenceBlocks) return suggestLowerMinDifference(series, band);
  return NO_SUGGESTION;
};

/**
 * Where the band's lines fall over the known prices, what those prices reach,
 * and a threshold suggestion when nothing is cheap or expensive: the settings
 * UI's threshold form states them, from the same classification as the level.
 */
export const summarizePriceLevels = (
  timeline: Pick<PriceTimeline, 'periods' | 'lines' | 'priceUnit'>,
  band: PriceLevelBand,
): PriceLevelSummary => {
  const prices = timeline.periods.map((period) => period.importPrice);
  return {
    lines: timeline.lines,
    lowest: Math.min(...prices),
    highest: Math.max(...prices),
    hasCheap: timeline.periods.some((period) => period.level === 'cheap'),
    hasExpensive: timeline.periods.some((period) => period.level === 'expensive'),
    priceUnit: timeline.priceUnit,
    suggestion: suggestPriceThreshold(timeline, band),
  };
};
