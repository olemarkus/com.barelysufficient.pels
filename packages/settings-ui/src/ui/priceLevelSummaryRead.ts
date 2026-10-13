import type {
  PriceLevelSummaryRead,
  PriceThresholdSuggestion,
} from '../../../contracts/src/settingsUiApi.ts';
import { isFiniteNumber } from '../../../shared-domain/src/numberGuards.ts';

const UNAVAILABLE: PriceLevelSummaryRead = { state: 'unavailable' };

const asRecord = (value: unknown): Record<string, unknown> | null => (
  typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null
);

// The runtime never suggests below the threshold field's minimum.
const MIN_SUGGESTED_PERCENT = 5;

const classifySuggestion = (value: unknown): PriceThresholdSuggestion => {
  const suggestion = asRecord(value);
  return suggestion?.kind === 'lower_threshold'
    && isFiniteNumber(suggestion.percent) && Number.isInteger(suggestion.percent)
    && suggestion.percent >= MIN_SUGGESTED_PERCENT
    && isFiniteNumber(suggestion.cheapUpTo)
    ? { kind: 'lower_threshold', percent: suggestion.percent, cheapUpTo: suggestion.cheapUpTo }
    : { kind: 'none' };
};

/**
 * The runtime's account of where the cheap and expensive lines fall, as it
 * crosses the Homey API bridge. A malformed read is `unavailable`, so the form
 * states no lines rather than wrong ones; a malformed suggestion is none.
 */
export const classifyPriceLevelSummaryRead = (value: unknown): PriceLevelSummaryRead => {
  const read = asRecord(value);
  const lines = asRecord(read?.lines);
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
