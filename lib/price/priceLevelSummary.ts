import type { PriceTimeline } from '../../packages/contracts/src/priceTimeline';
import type { PriceLevelSummary, PriceThresholdSuggestion } from '../../packages/contracts/src/settingsUiApi';
import type { PriceLevelBand } from './priceLevelUtils';
import { calculateThresholds, getPriceLevelFlags } from './priceMath';

// Below this the prices are effectively flat: a lower threshold would mark
// differences of a few percent, which no device trades comfort for. It is also
// the threshold field's own minimum, so a suggestion is always one it accepts.
const MIN_SUGGESTED_PERCENT = 5;

const NO_SUGGESTION: PriceThresholdSuggestion = { kind: 'none' };

/**
 * The largest whole-percent threshold at which the cheapest quarter of the
 * known prices counts as cheap, for a series where nothing is cheap or
 * expensive at the owner's band. Under Norgespris, for example, the fixed
 * electricity price leaves only the grid tariff to move the price, and the
 * default 25 % finds no cheap hour. The minimum difference still applies, so a
 * suggestion it would block is not made.
 */
export const suggestPriceThreshold = (
  timeline: Pick<PriceTimeline, 'periods' | 'lines'>,
  band: PriceLevelBand,
): PriceThresholdSuggestion => {
  const { periods, lines } = timeline;
  if (periods.length === 0 || periods.some((period) => period.level !== 'normal')) return NO_SUGGESTION;
  if (lines.average <= 0) return NO_SUGGESTION;
  const sorted = periods.map((period) => period.importPrice).sort((a, b) => a - b);
  // The highest price among the cheapest quarter of the periods.
  const cheapUpTo = sorted[Math.max(1, Math.floor(sorted.length / 4)) - 1];
  if (cheapUpTo === undefined || lines.average - cheapUpTo < band.minDiff) return NO_SUGGESTION;
  // The classifier has the last word: a percent on the exact boundary can miss
  // by a rounding error, so step down until the price really counts as cheap.
  const countsAsCheap = (percent: number): boolean => getPriceLevelFlags({
    price: cheapUpTo,
    avgPrice: lines.average,
    thresholds: calculateThresholds(lines.average, percent),
    minDiff: band.minDiff,
  }).isCheap;
  let percent = Math.floor((1 - cheapUpTo / lines.average) * 100 + 1e-9);
  while (percent >= MIN_SUGGESTED_PERCENT && !countsAsCheap(percent)) percent -= 1;
  return percent >= MIN_SUGGESTED_PERCENT ? { kind: 'lower_threshold', percent, cheapUpTo } : NO_SUGGESTION;
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
