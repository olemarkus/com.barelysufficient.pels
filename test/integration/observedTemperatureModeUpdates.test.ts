import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ObservedTemperatureModeUpdates } from '../../lib/home/observedTemperatureModeUpdates';
import { mockHomeyInstance, resetMockHomey } from '../mocks/homey';

const adjustment = { deviceId: 'heater', temperature: 22, observedAtMs: 1000 };

describe('observation-origin mode edits', () => {
  beforeEach(() => {
    resetMockHomey();
  });

  const start = (homeId = 'main') => {
    const settings = mockHomeyInstance.settings;
    const key = homeId === 'main' ? 'mode_device_targets' : `mode_device_targets:${homeId}`;
    settings.set('temperature_control_modes', { heater: 'update_mode' });
    settings.set(key, { Home: { heater: 23.5, other: 19 }, Away: { heater: 15 } });
    const reloadMain = vi.fn();
    const reloadArea = vi.fn();
    const resolveMode = vi.fn(() => ({
      state: 'resolved' as const, mode: 'Home', homeId, catalogHomeId: homeId,
    }));
    const isLimited = vi.fn(() => false);
    const service = new ObservedTemperatureModeUpdates(
      settings, resolveMode, () => true, reloadMain, () => [{ reloadModeCatalog: reloadArea }], (_id, value) => value,
      isLimited, () => [],
    );
    return { settings, key, service, reloadMain, reloadArea, resolveMode, isLimited };
  };

  it('authorizes the normalized saved target rather than an old adjusted target', () => {
    const { settings, resolveMode } = start();
    const service = new ObservedTemperatureModeUpdates(
      settings, resolveMode, () => true, vi.fn(), () => [], (_id, value) => Math.round(value), () => false, () => [],
    );
    expect(service.allowsTarget('heater', 24)).toBe(true);
    expect(service.allowsTarget('heater', 23.5)).toBe(false);
    expect(service.allowsTarget('heater', 16)).toBe(false);
  });

  it('authorizes the producer\'s limits under Save as current mode target, in either direction', () => {
    // Limiting still applies under that policy; only the price and solar offsets
    // are switched off. The fence cannot tell which way the device is moving
    // demand, so both limits are legitimate writes. They come from the
    // shed-behaviour producer, so a limit it derives (a device with no on/off
    // limited through its setpoint) is admitted just as a saved one is.
    const { settings, resolveMode } = start();
    const readLimits = vi.fn(() => [16.4, 26.2]);
    const service = new ObservedTemperatureModeUpdates(
      settings, resolveMode, () => true, vi.fn(), () => [], (_id, value) => Math.round(value), () => false, readLimits,
    );
    expect(service.allowsTarget('heater', 16)).toBe(true);
    expect(service.allowsTarget('heater', 26)).toBe(true);
    expect(service.allowsTarget('heater', 20)).toBe(false);
    expect(readLimits).toHaveBeenCalledWith('heater');
  });

  it('allows limiting under Save as current mode target and denies it only under Keep the new temperature', () => {
    const { service, settings } = start();
    expect(service.allowsLimiting('heater')).toBe(true);
    expect(service.allowsAutomaticAdjustments('heater')).toBe(false);
    settings.set('temperature_control_modes', { heater: 'external' });
    expect(service.allowsLimiting('heater')).toBe(false);
  });

  it('does not save a change made while PELS has the device limited', () => {
    // A nudge during a peak is a reaction to the limit, not a new preference.
    // Left unsaved, the executor sees observed and desired disagree and brings
    // the device back onto its limit — ordinary drift.
    const { settings, key, service, reloadMain, isLimited } = start();
    isLimited.mockReturnValue(true);
    service.accept(adjustment);
    expect(settings.get(key)).toEqual({ Home: { heater: 23.5, other: 19 }, Away: { heater: 15 } });
    expect(reloadMain).not.toHaveBeenCalled();

    isLimited.mockReturnValue(false);
    service.accept(adjustment);
    expect(settings.get(key)).toEqual({ Home: { heater: 22, other: 19 }, Away: { heater: 15 } });
  });

  it('holds the last good policy through transient settings failures', () => {
    const { service, settings } = start();
    expect(service.allowsAutomaticAdjustments('heater')).toBe(false);
    const read = vi.spyOn(settings, 'get').mockReturnValueOnce(null);
    expect(service.allowsAutomaticAdjustments('heater')).toBe(false);
    read.mockImplementationOnce(() => { throw new Error('temporary'); });
    expect(service.allowsAutomaticAdjustments('heater')).toBe(false);
    read.mockRestore();
    settings.set('temperature_control_modes', { heater: 'mode' });
    expect(service.allowsAutomaticAdjustments('heater')).toBe(true);
  });

  it.each(['main', 'annex'])('updates only the active mode and device in %s', (homeId) => {
    const { settings, key, service, reloadMain, reloadArea } = start(homeId);
    const ordinarySettingsHandler = vi.fn();
    settings.on('set', (changedKey: string) => {
      if (!service.consumeSettingChange(changedKey)) ordinarySettingsHandler(changedKey);
    });
    service.accept(adjustment);
    expect(settings.get(key)).toEqual({ Home: { heater: 22, other: 19 }, Away: { heater: 15 } });
    expect(ordinarySettingsHandler).not.toHaveBeenCalled();
    expect(reloadMain).toHaveBeenCalledOnce();
    expect(reloadArea).toHaveBeenCalledOnce();
    expect(service.consumeSettingChange(key)).toBe(false);
    // A later UI edit must take the ordinary path.
    settings.set(key, { Home: { heater: 21 } });
    expect(ordinarySettingsHandler).toHaveBeenCalledOnce();
  });

  it('consumes multiple delayed notifications but never swallows another editor’s value', () => {
    const { service, settings, key } = start();
    service.accept(adjustment);
    service.accept({ ...adjustment, temperature: 21 });
    expect(service.consumeSettingChange(key)).toBe(true);
    expect(service.consumeSettingChange(key)).toBe(true);
    expect(service.consumeSettingChange(key)).toBe(false);
    service.accept({ ...adjustment, temperature: 20 });
    settings.set(key, { Home: { heater: 24 } });
    expect(service.consumeSettingChange(key)).toBe(false);
  });

  it('does not turn a transient read failure on its notification into a rebuild', () => {
    const { service, settings, key } = start();
    service.accept(adjustment);
    const read = vi.spyOn(settings, 'get');
    read.mockReturnValueOnce(null);
    expect(service.consumeSettingChange(key)).toBe(true);
    read.mockImplementationOnce(() => { throw new Error('temporary miss'); });
    expect(service.consumeSettingChange(key)).toBe(true);
    expect(service.consumeSettingChange(key)).toBe(true);
    expect(service.consumeSettingChange(key)).toBe(false);
    read.mockRestore();
  });

  it.each(['mode', 'external', null])('does not adopt under policy %s', (mode) => {
    const { settings, key, service, reloadMain } = start();
    settings.set('temperature_control_modes', mode ? { heater: mode } : null);
    service.accept(adjustment);
    expect(settings.get(key)).toMatchObject({ Home: { heater: 23.5 } });
    expect(reloadMain).not.toHaveBeenCalled();
  });

  it.each([null, { Home: { heater: Number.NaN } }, {}])('preserves unavailable or incomplete catalogs', (catalog) => {
    const { settings, key, service, reloadMain } = start();
    settings.set(key, catalog);
    service.accept(adjustment);
    expect(settings.get(key)).toEqual(catalog);
    expect(reloadMain).not.toHaveBeenCalled();
  });

  it('uses the active mode of each accepted event and ignores duplicate values', () => {
    const { service, settings, key, resolveMode, reloadMain } = start();
    service.accept(adjustment);
    service.accept(adjustment);
    expect(reloadMain).toHaveBeenCalledOnce();
    resolveMode.mockReturnValue({ state: 'resolved', mode: 'Away', homeId: 'main', catalogHomeId: 'main' });
    service.accept({ ...adjustment, temperature: 17 });
    expect(settings.get(key)).toEqual({ Home: { heater: 22, other: 19 }, Away: { heater: 17 } });
  });
});
