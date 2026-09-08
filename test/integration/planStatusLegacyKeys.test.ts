import { beforeEach, describe, expect, it, vi } from 'vitest';
import { retireLegacyPlanStatusKeys } from '../../lib/plan/planStatusRegistry';
import { mockHomeyInstance } from '../mocks/homey';

// The status left settings for the app's memory: nothing is imported (a
// previous run's status is exactly what must not be served), the old keys —
// main's bare one and every area's suffixed one — are unset once at boot,
// and a key list that cannot be read leaves them for the next boot.
describe('retireLegacyPlanStatusKeys', () => {
  beforeEach(() => {
    mockHomeyInstance.settings.removeAllListeners();
    mockHomeyInstance.settings.clear();
    vi.restoreAllMocks();
  });

  it('unsets the bare key and every suffixed one, and nothing else', () => {
    mockHomeyInstance.settings.set('pels_status', { headroomKw: 1 });
    mockHomeyInstance.settings.set('pels_status:h_area', { headroomKw: 2 });
    mockHomeyInstance.settings.set('pels_status_unrelated', 'kept');
    mockHomeyInstance.settings.set('capacity_in_shortfall', false);

    retireLegacyPlanStatusKeys(mockHomeyInstance.settings);

    expect(mockHomeyInstance.settings.getKeys().sort()).toEqual(['capacity_in_shortfall', 'pels_status_unrelated']);
  });

  it('touches nothing when the key list cannot be read', () => {
    mockHomeyInstance.settings.set('pels_status', { headroomKw: 1 });
    vi.spyOn(mockHomeyInstance.settings, 'getKeys').mockImplementation(() => { throw new Error('settings unavailable'); });
    const unset = vi.spyOn(mockHomeyInstance.settings, 'unset');

    retireLegacyPlanStatusKeys(mockHomeyInstance.settings);

    expect(unset).not.toHaveBeenCalled();
  });

  it('leaves every key for the next boot when an unset is rejected', () => {
    mockHomeyInstance.settings.set('pels_status', { headroomKw: 1 });
    mockHomeyInstance.settings.set('pels_status:h_area', { headroomKw: 2 });
    vi.spyOn(mockHomeyInstance.settings, 'unset').mockImplementation(() => { throw new Error('settings unavailable'); });

    expect(() => retireLegacyPlanStatusKeys(mockHomeyInstance.settings)).not.toThrow();
    expect(mockHomeyInstance.settings.getKeys().sort()).toEqual(['pels_status', 'pels_status:h_area']);
  });
});
