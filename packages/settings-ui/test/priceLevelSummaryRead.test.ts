import { describe, expect, it } from 'vitest';
import { classifyPriceLevelSummaryRead } from '../src/ui/priceLevelSummaryRead.ts';

const READY = {
  state: 'ready',
  lines: { average: 75.3, cheapAtOrBelow: 56.5, expensiveFrom: 94.2 },
  lowest: 68,
  highest: 79,
  hasCheap: false,
  hasExpensive: false,
  priceUnit: 'øre/kWh',
  suggestion: { kind: 'lower_threshold', percent: 9, cheapUpTo: 68 },
};

describe('classifyPriceLevelSummaryRead', () => {
  it('accepts a whole summary', () => {
    expect(classifyPriceLevelSummaryRead(READY)).toEqual(READY);
  });

  it('states no lines from a malformed read, and drops a malformed suggestion on its own', () => {
    expect(classifyPriceLevelSummaryRead({ ...READY, lines: { average: 75.3 } })).toEqual({ state: 'unavailable' });
    expect(classifyPriceLevelSummaryRead(undefined)).toEqual({ state: 'unavailable' });
    expect(classifyPriceLevelSummaryRead({ ...READY, suggestion: { kind: 'lower_threshold', percent: 9.5, cheapUpTo: 68 } }))
      .toEqual({ ...READY, suggestion: { kind: 'none' } });
    // Below the threshold field's minimum, which the runtime never suggests.
    expect(classifyPriceLevelSummaryRead({ ...READY, suggestion: { kind: 'lower_threshold', percent: 1, cheapUpTo: 68 } }))
      .toEqual({ ...READY, suggestion: { kind: 'none' } });
  });

  it('accepts a lower minimum difference, and drops a malformed one', () => {
    const minDifference = { kind: 'lower_min_difference', minDifference: 9, cheapUpTo: 73.84 };
    expect(classifyPriceLevelSummaryRead({ ...READY, suggestion: minDifference }))
      .toEqual({ ...READY, suggestion: minDifference });
    expect(classifyPriceLevelSummaryRead({ ...READY, suggestion: { ...minDifference, minDifference: -1 } }))
      .toEqual({ ...READY, suggestion: { kind: 'none' } });
    expect(classifyPriceLevelSummaryRead({ ...READY, suggestion: { ...minDifference, cheapUpTo: 'x' } }))
      .toEqual({ ...READY, suggestion: { kind: 'none' } });
  });
});
