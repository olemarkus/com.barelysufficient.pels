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
    const isLimited = vi.fn(() => false);
    const cancelCurrentPriceShift = vi.fn(() => true);
    const allowsCurrentPriceShiftTarget = vi.fn(() => false);
    const priceShiftPolicy = { cancelCurrentPriceShift, allowsCurrentPriceShiftTarget };
    const service = new ObservedTemperatureModeUpdates(
      settings,
      resolveMode,
      () => true,
      () => { reloadMain(); reloadArea(); },
      (_id, value) => value,
      isLimited,
      priceShiftPolicy,
    );
    return {
      settings, key, service, reloadMain, reloadArea, resolveMode, isLimited, cancelCurrentPriceShift,
      allowsCurrentPriceShiftTarget,
    };
  };

  it('authorizes the normalized saved target rather than an old adjusted target', () => {
    const { settings, resolveMode } = start();
    const service = new ObservedTemperatureModeUpdates(
      settings, resolveMode, () => true, vi.fn(), (_id, value) => Math.round(value), () => false,
      { cancelCurrentPriceShift: vi.fn(), allowsCurrentPriceShiftTarget: vi.fn(() => false) },
    );
    expect(service.allowsTarget('heater', 24)).toBe(true);
    expect(service.allowsTarget('heater', 23.5)).toBe(false);
    expect(service.allowsTarget('heater', 16)).toBe(false);
  });

  it('authorizes only the current price target from the saved mode target', () => {
    const { service, allowsCurrentPriceShiftTarget } = start();
    allowsCurrentPriceShiftTarget.mockReturnValue(true);
    expect(service.allowsTarget('heater', 20)).toBe(true);
    expect(allowsCurrentPriceShiftTarget).toHaveBeenCalledExactlyOnceWith('heater', 23.5, 20);
    allowsCurrentPriceShiftTarget.mockReturnValue(false);
    expect(service.allowsTarget('heater', 21)).toBe(false);
  });

  it('authorizes the owner\'s configured limit under Save as current mode target, in either direction', () => {
    // Limiting still applies under that policy; solar offsets are switched off.
    // The fence cannot tell which way the device is moving
    // demand, so both of the owner's limits are legitimate writes.
    const { settings, resolveMode } = start();
    settings.set('overshoot_behaviors', {
      heater: { action: 'set_temperature', temperature: 16.4, coolingTemperature: 26.2 },
    });
    const service = new ObservedTemperatureModeUpdates(
      settings, resolveMode, () => true, vi.fn(), (_id, value) => Math.round(value), () => false,
      { cancelCurrentPriceShift: vi.fn(), allowsCurrentPriceShiftTarget: vi.fn(() => false) },
    );
    expect(service.allowsTarget('heater', 16)).toBe(true);
    expect(service.allowsTarget('heater', 26)).toBe(true);
    expect(service.allowsTarget('heater', 20)).toBe(false);
  });

  it('keeps the configured limits across a transient null read of the map', () => {
    // The SDK answers `null` for a key that exists, now and then. The limits it
    // held are the last good value, so the fence keeps admitting them; an emptied
    // map here would refuse the executor's own limit write.
    const { settings, resolveMode } = start();
    settings.set('overshoot_behaviors', {
      heater: { action: 'set_temperature', temperature: 16, coolingTemperature: 27 },
    });
    const service = new ObservedTemperatureModeUpdates(
      settings, resolveMode, () => true, vi.fn(), (_id, value) => value, () => false,
      { cancelCurrentPriceShift: vi.fn(), allowsCurrentPriceShiftTarget: vi.fn(() => false) },
    );
    expect(service.allowsTarget('heater', 16)).toBe(true);
    vi.spyOn(settings, 'get').mockImplementationOnce(() => null);
    expect(service.allowsTarget('heater', 16)).toBe(true);
    expect(service.allowsTarget('heater', 27)).toBe(true);
  });

  it('allows limiting under Save as current mode target and denies it only under Keep the new temperature', () => {
    const { service, settings } = start();
    expect(service.allowsLimiting('heater')).toBe(true);
    expect(service.allowsSolarAdjustments('heater')).toBe(false);
    expect(service.allowsTemperatureSmartTasks('heater')).toBe(false);
    expect(service.allowsPriceBasedDeltas('heater')).toBe(true);
    settings.set('temperature_control_modes', { heater: 'external' });
    expect(service.allowsLimiting('heater')).toBe(false);
    expect(service.allowsSolarAdjustments('heater')).toBe(false);
    expect(service.allowsPriceBasedDeltas('heater')).toBe(false);
  });

  it('does not save a change made while PELS has the device limited', () => {
    // A nudge during a peak is a reaction to the limit, not a new preference.
    // Left unsaved, the executor sees observed and desired disagree and brings
    // the device back onto its limit — ordinary drift.
    const { settings, key, service, reloadMain, isLimited, cancelCurrentPriceShift } = start();
    isLimited.mockReturnValue(true);
    service.accept(adjustment);
    expect(settings.get(key)).toEqual({ Home: { heater: 23.5, other: 19 }, Away: { heater: 15 } });
    expect(reloadMain).not.toHaveBeenCalled();
    expect(cancelCurrentPriceShift).not.toHaveBeenCalled();

    isLimited.mockReturnValue(false);
    service.accept(adjustment);
    expect(settings.get(key)).toEqual({ Home: { heater: 22, other: 19 }, Away: { heater: 15 } });
    expect(cancelCurrentPriceShift).toHaveBeenCalledExactlyOnceWith('heater');
  });

  it('cancels the active shift when a manual change returns to the saved target', () => {
    const { settings, key, service, reloadMain, cancelCurrentPriceShift } = start();
    service.accept({ ...adjustment, temperature: 23.5 });

    expect(settings.get(key)).toEqual({ Home: { heater: 23.5, other: 19 }, Away: { heater: 15 } });
    expect(cancelCurrentPriceShift).toHaveBeenCalledExactlyOnceWith('heater');
    expect(reloadMain).not.toHaveBeenCalled();
  });

  it('does not save the manual target when its price-shift hold cannot be persisted', () => {
    const { settings, key, service, reloadMain, cancelCurrentPriceShift } = start();
    cancelCurrentPriceShift.mockReturnValue(false);

    service.accept(adjustment);

    expect(settings.get(key)).toEqual({ Home: { heater: 23.5, other: 19 }, Away: { heater: 15 } });
    expect(reloadMain).not.toHaveBeenCalled();
  });

  it('does not leave a hold behind when the mode target cannot be saved', () => {
    const { settings, key, service, cancelCurrentPriceShift, reloadMain } = start();
    const originalSet = settings.set.bind(settings);
    const set = vi.spyOn(settings, 'set').mockImplementation((settingKey, value) => {
      if (settingKey === key) throw new Error('temporary settings failure');
      return originalSet(settingKey, value);
    });

    service.accept(adjustment);

    expect(settings.get(key)).toEqual({ Home: { heater: 23.5, other: 19 }, Away: { heater: 15 } });
    expect(settings.get('thermostat_price_shift_cancellation.heater')).toBeNull();
    expect(cancelCurrentPriceShift).not.toHaveBeenCalled();
    expect(reloadMain).not.toHaveBeenCalled();
    set.mockRestore();
  });

  it('holds the last good policy through transient settings failures', () => {
    const { service, settings } = start();
    expect(service.allowsSolarAdjustments('heater')).toBe(false);
    const read = vi.spyOn(settings, 'get').mockReturnValueOnce(null);
    expect(service.allowsSolarAdjustments('heater')).toBe(false);
    read.mockImplementationOnce(() => { throw new Error('temporary'); });
    expect(service.allowsSolarAdjustments('heater')).toBe(false);
    read.mockRestore();
    settings.set('temperature_control_modes', { heater: 'mode' });
    expect(service.allowsSolarAdjustments('heater')).toBe(true);
  });

  it.each(['main', 'annex'])('updates only the active mode and device in %s', (homeId) => {
    const { settings, key, service, reloadMain, reloadArea, cancelCurrentPriceShift } = start(homeId);
    const ordinarySettingsHandler = vi.fn();
    settings.on('set', (changedKey: string) => {
      if (!service.consumeSettingChange(changedKey)) ordinarySettingsHandler(changedKey);
    });
    service.accept(adjustment);
    expect(settings.get(key)).toEqual({ Home: { heater: 22, other: 19 }, Away: { heater: 15 } });
    expect(ordinarySettingsHandler).not.toHaveBeenCalled();
    expect(reloadMain).toHaveBeenCalledOnce();
    expect(reloadArea).toHaveBeenCalledOnce();
    expect(cancelCurrentPriceShift).toHaveBeenCalledExactlyOnceWith('heater');
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
