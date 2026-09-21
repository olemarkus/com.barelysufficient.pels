import { classifyCapacityPeak } from '../src/ui/capacityPeakRead.ts';

describe('capacity peak API classification', () => {
  it('rejects a negative peak before it reaches settings business logic', () => {
    expect(classifyCapacityPeak({ state: 'recorded', peakKw: -1 })).toEqual({ state: 'unavailable' });
  });
});
