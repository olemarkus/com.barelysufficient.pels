import { describe, expect, it } from 'vitest';
import {
  composeMonthPeakStateLine,
  composeSafePaceSummaryCopy,
  resolveMonthPeakHold,
  resolveMonthPeakReadout,
} from '../src/ui/monthPeakHoldCopy.ts';

const PEAK = { state: 'recorded', peakKw: 6.4, source: 'tracked' } as const;

describe('month peak hold copy', () => {
  it('holds this month\'s peak only with the switch on, the 15-minute period and a peak above the hard cap', () => {
    expect(resolveMonthPeakHold(4, 15, true, PEAK)).toEqual({ heldKw: 6.4, hardCapKw: 4 });
    expect(resolveMonthPeakHold(4, 15, false, PEAK)).toBeNull();
    expect(resolveMonthPeakHold(4, 60, true, PEAK)).toBeNull();
    expect(resolveMonthPeakHold(6.4, 15, true, PEAK)).toBeNull();
    expect(resolveMonthPeakHold(4, 15, true, { state: 'no_completed_quarter' })).toBeNull();
    expect(resolveMonthPeakHold(4, 15, true, { state: 'unavailable' })).toBeNull();
  });

  it('keeps the usual safe-pace summary while the hard cap applies', () => {
    expect(composeSafePaceSummaryCopy(null)).toEqual({
      label: 'With these settings, safe pace starts each period at',
      note: '(hard cap minus safety margin; it adapts as the period is used)',
    });
  });

  it('names the held peak and the hard cap it stands in for', () => {
    expect(composeSafePaceSummaryCopy({ heldKw: 6.43, hardCapKw: 4 })).toEqual({
      label: 'This month PELS holds 6.4 kW, your highest completed quarter so far. Safe pace starts each period at',
      note: '(that peak minus the safety margin). Your hard cap of 4 kW applies again from the 1st of next month.',
    });
  });

  it('points to the switch only while it is off and the peak is above the hard cap', () => {
    expect(composeMonthPeakStateLine(4, 15, false, PEAK))
      .toBe('Above your hard cap. Turn on Follow this month’s peak to let devices use it.');
    expect(composeMonthPeakStateLine(4, 15, true, PEAK)).toBeNull();
    expect(composeMonthPeakStateLine(8, 15, false, PEAK)).toBeNull();
    expect(composeMonthPeakStateLine(4, 60, false, PEAK)).toBeNull();
  });

  it('says nothing about the peak while the hard cap is still being typed', () => {
    expect(resolveMonthPeakReadout(null, 15, false, PEAK)).toEqual({ hold: null, stateLine: null });
    expect(resolveMonthPeakReadout(4, 15, true, PEAK)).toEqual({ hold: { heldKw: 6.4, hardCapKw: 4 }, stateLine: null });
  });
});
