import { isGrayStateDevice } from '../src/ui/deviceUtils.ts';

describe('isGrayStateDevice', () => {
  it('flags unavailable, stale, and disappeared devices as gray', () => {
    expect(isGrayStateDevice({ available: false })).toBe(true);
    expect(isGrayStateDevice({ observationStale: true })).toBe(true);
    expect(isGrayStateDevice({ currentState: 'unknown' })).toBe(true);
    expect(isGrayStateDevice({ currentState: 'disappeared' })).toBe(true);
  });

  it('keeps active devices out of the gray state', () => {
    expect(isGrayStateDevice({ available: true, currentState: 'on' })).toBe(false);
    expect(isGrayStateDevice({ available: true, currentState: 'off' })).toBe(false);
  });
});
