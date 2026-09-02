import { beforeEach, describe, expect, it, vi } from 'vitest';
import { POWER_SOURCE } from '../../lib/utils/settingsKeys';
import { readPowerSourceChoice } from '../../setup/powerSourceChoice';
import { readConfiguredPowerSource } from '../../setup/powerSourceSettings';
import { mockHomeyInstance } from '../mocks/homey';

describe('readConfiguredPowerSource', () => {
  beforeEach(() => {
    mockHomeyInstance.settings.clear();
    vi.restoreAllMocks();
  });

  it('keeps the historical Flow default for a genuinely unwritten key', () => {
    mockHomeyInstance.settings.set('another_setting', true);

    expect(readConfiguredPowerSource(mockHomeyInstance.settings)).toEqual({
      state: 'resolved',
      value: 'flow',
    });
  });

  it('treats an exact-key undefined read as suspect and never writes a fallback', () => {
    mockHomeyInstance.settings.set(POWER_SOURCE, 'homey_energy');
    const originalGet = mockHomeyInstance.settings.get.bind(mockHomeyInstance.settings);
    vi.spyOn(mockHomeyInstance.settings, 'get').mockImplementation((key) => (
      key === POWER_SOURCE ? undefined : originalGet(key)
    ));
    const setSpy = vi.spyOn(mockHomeyInstance.settings, 'set');

    expect(readConfiguredPowerSource(mockHomeyInstance.settings)).toMatchObject({
      state: 'suspect',
      reason: 'missing_existing_key',
    });
    expect(setSpy).not.toHaveBeenCalled();
  });

  it('treats absent source with a store-wide empty key list as suspect', () => {
    expect(readConfiguredPowerSource(mockHomeyInstance.settings)).toMatchObject({
      state: 'suspect',
      reason: 'empty_key_list',
    });
  });

  it('retains the historical Flow fallback for malformed non-null values', () => {
    mockHomeyInstance.settings.set(POWER_SOURCE, { unexpected: true });

    expect(readConfiguredPowerSource(mockHomeyInstance.settings)).toEqual({
      state: 'resolved',
      value: 'flow',
    });
  });
});

describe('readPowerSourceChoice', () => {
  beforeEach(() => {
    mockHomeyInstance.settings.clear();
    vi.restoreAllMocks();
  });

  it('keeps an unwritten key distinct from a Flow choice', () => {
    mockHomeyInstance.settings.set('another_setting', true);
    expect(readPowerSourceChoice(mockHomeyInstance.settings)).toEqual({ state: 'unset' });
    mockHomeyInstance.settings.set(POWER_SOURCE, 'flow');
    expect(readPowerSourceChoice(mockHomeyInstance.settings)).toEqual({ state: 'chosen', value: 'flow' });
  });

  it('answers read_failed, not unset, when the settings read throws', () => {
    vi.spyOn(mockHomeyInstance.settings, 'get').mockImplementation(() => { throw new Error('boom'); });
    expect(readPowerSourceChoice(mockHomeyInstance.settings)).toEqual({ state: 'suspect', reason: 'read_failed' });
  });
});
