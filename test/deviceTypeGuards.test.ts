import { isHomeyDeviceLike } from '../lib/utils/types';

describe('isHomeyDeviceLike', () => {
  it('rejects arrays', () => {
    expect(isHomeyDeviceLike([])).toBe(false);
  });

  it('accepts objects with string id and name', () => {
    expect(isHomeyDeviceLike({ id: 'dev-1', name: 'Heater' })).toBe(true);
  });
});
