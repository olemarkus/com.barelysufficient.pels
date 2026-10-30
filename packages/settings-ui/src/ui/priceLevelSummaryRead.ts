import type {
  PriceLevelSummaryRead,
  PriceThresholdSuggestion,
} from '../../../contracts/src/settingsUi/prices.ts';
import { isFiniteNumber } from '../../../shared-domain/src/numberGuards.ts';
import { asUnknownRecord } from '../../../shared-domain/src/recordGuards.ts';

const UNAVAILABLE: PriceLevelSummaryRead = { state: 'unavailable' };

// The runtime never suggests below the threshold field's minimum.
const MIN_SUGGESTED_PERCENT = 5;

const NO_SUGGESTION: PriceThresholdSuggestion = { kind: 'none' };

const classifySuggestion = (value: unknown): PriceThresholdSuggestion => {
  const suggestion = asUnknownRecord(value);
  if (!suggestion || !isFiniteNumber(suggestion.cheapUpTo)) return NO_SUGGESTION;
  const { cheapUpTo } = suggestion;
  if (
    suggestion.kind === 'lower_threshold'
    && isFiniteNumber(suggestion.percent) && Number.isInteger(suggestion.percent)
    && suggestion.percent >= MIN_SUGGESTED_PERCENT
  ) {
    return { kind: 'lower_threshold', percent: suggestion.percent, cheapUpTo };
  }
  if (
    suggestion.kind === 'lower_min_difference'
    && isFiniteNumber(suggestion.minDifference) && suggestion.minDifference >= 0
  ) {
    return { kind: 'lower_min_difference', minDifference: suggestion.minDifference, cheapUpTo };
  }
  return NO_SUGGESTION;
};

/**
 * The runtime's account of where the cheap and expensive lines fall, as it
 * crosses the Homey API bridge. A malformed read is `unavailable`, so the form
 * states no lines rather than wrong ones; a malformed suggestion is none.
 */
export const classifyPriceLevelSummaryRead = (value: unknown): PriceLevelSummaryRead => {
  const read = asUnknownRecord(value);
  const lines = asUnknownRecord(read?.lines);
  if (
    read?.state !== 'ready' || !lines
    || !isFiniteNumber(lines.average) || !isFiniteNumber(lines.cheapAtOrBelow) || !isFiniteNumber(lines.expensiveFrom)
    || !isFiniteNumber(read.lowest) || !isFiniteNumber(read.highest)
    || typeof read.hasCheap !== 'boolean' || typeof read.hasExpensive !== 'boolean'
    || typeof read.priceUnit !== 'string'
  ) {
    return UNAVAILABLE;
  }
  return {
    state: 'ready',
    lines: { average: lines.average, cheapAtOrBelow: lines.cheapAtOrBelow, expensiveFrom: lines.expensiveFrom },
    lowest: read.lowest,
    highest: read.highest,
    hasCheap: read.hasCheap,
    hasExpensive: read.hasExpensive,
    priceUnit: read.priceUnit,
    suggestion: classifySuggestion(read.suggestion),
  };
};
