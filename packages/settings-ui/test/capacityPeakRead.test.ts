import {
  capacityPeakNote,
  classifyCapacityPeak,
  METER_CAPACITY_PEAK_NOTE,
} from '../src/ui/capacityPeakRead.ts';

describe('capacity peak API classification', () => {
  it('rejects a negative peak before it reaches settings business logic', () => {
    expect(classifyCapacityPeak({ state: 'recorded', peakKw: -1, source: 'tracked' })).toEqual({ state: 'unavailable' });
  });

  it('keeps which value set the peak, and rejects a peak that does not say', () => {
    expect(classifyCapacityPeak({ state: 'recorded', peakKw: 6.4, source: 'meter' }))
      .toEqual({ state: 'recorded', peakKw: 6.4, source: 'meter' });
    expect(classifyCapacityPeak({ state: 'recorded', peakKw: 6.4 })).toEqual({ state: 'unavailable' });
    expect(classifyCapacityPeak({ state: 'recorded', peakKw: 6.4, source: 'bill' })).toEqual({ state: 'unavailable' });
  });
});

describe('capacity peak note', () => {
  it('says the meter reported the peak only when the meter\'s value is in use', () => {
    expect(capacityPeakNote({ state: 'recorded', peakKw: 6.4, source: 'meter' }, 'tracked'))
      .toBe(METER_CAPACITY_PEAK_NOTE);
    expect(capacityPeakNote({ state: 'recorded', peakKw: 6.4, source: 'tracked' }, 'tracked')).toBe('tracked');
    expect(capacityPeakNote({ state: 'no_completed_quarter' }, 'tracked')).toBe('tracked');
  });
});
