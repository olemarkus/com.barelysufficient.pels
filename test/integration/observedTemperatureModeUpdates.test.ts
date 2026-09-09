import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ObservedTemperatureModeUpdates } from '../../lib/home/observedTemperatureModeUpdates';
import { mockHomeyInstance } from '../mocks/homey';

const adjustment = { deviceId: 'heater', temperature: 22, observedAtMs: 1000 };

describe('observation-origin mode edits', () => {
  beforeEach(() => {
    mockHomeyInstance.settings.removeAllListeners();
    mockHomeyInstance.settings.clear();
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
    const service = new ObservedTemperatureModeUpdates(
      settings, resolveMode, () => true, reloadMain, () => [{ reloadModeCatalog: reloadArea }], (_id, value) => value,
    );
    return { settings, key, service, reloadMain, reloadArea, resolveMode };
  };

  it('authorizes the normalized saved target rather than an old adjusted target', () => {
    const { settings, resolveMode } = start();
    const service = new ObservedTemperatureModeUpdates(
      settings, resolveMode, () => true, vi.fn(), () => [], (_id, value) => Math.round(value),
    );
    expect(service.allowsTarget('heater', 24)).toBe(true);
    expect(service.allowsTarget('heater', 23.5)).toBe(false);
    expect(service.allowsTarget('heater', 16)).toBe(false);
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
