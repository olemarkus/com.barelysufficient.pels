import { describe, expect, it } from 'vitest';
import { createPriceOptimizationSettingsStore } from '../../lib/price/priceOptimizationSettingsStore';
import {
  PRICE_OPTIMIZATION_ENABLED,
  PRICE_OPTIMIZATION_SETTINGS,
  PRICE_THRESHOLD_PERCENT,
} from '../../lib/utils/settingsKeys';
import { MockSettings } from '../mocks/homey';

describe('createPriceOptimizationSettingsStore setup read', () => {
  it('names a malformed operational device-settings read as unavailable', () => {
    const settings = new MockSettings();
    settings.set(PRICE_OPTIMIZATION_SETTINGS, { heater: { enabled: false } });
    const store = createPriceOptimizationSettingsStore(settings);

    expect(store.readDeviceSettings()).toEqual({ state: 'unavailable' });
  });

  it('resolves legacy operational entries before handing them to runtime business logic', () => {
    const settings = new MockSettings();
    settings.set(PRICE_OPTIMIZATION_SETTINGS, {
      heater: { enabled: false, cheapDelta: 5, expensiveDelta: -5 },
    });
    const store = createPriceOptimizationSettingsStore(settings);

    expect(store.readDeviceSettings()).toEqual({
      state: 'resolved',
      settings: {
        heater: {
          enabled: false,
          cheapDelta: 5,
          expensiveDelta: -5,
          priceConfigured: true,
          surplusWilling: false,
          surplusDelta: 0,
        },
      },
    });
  });

  it('treats an empty SDK key inventory as unavailable', () => {
    const store = createPriceOptimizationSettingsStore(new MockSettings());

    expect(store.readSetup()).toEqual({ state: 'unavailable' });
  });

  it('resolves canonical defaults when price keys were never written', () => {
    const settings = new MockSettings();
    settings.set(PRICE_THRESHOLD_PERCENT, 25);
    const store = createPriceOptimizationSettingsStore(settings);

    expect(store.readSetup()).toEqual({
      state: 'resolved',
      setup: { enabled: true, configuredDeviceIds: [], solarSurplusDeviceIds: [] },
    });
  });

  it('retains explicit global and per-device opt-outs as configured facts', () => {
    const settings = new MockSettings();
    settings.set(PRICE_OPTIMIZATION_ENABLED, false);
    settings.set(PRICE_OPTIMIZATION_SETTINGS, {
      disabled: { enabled: false, cheapDelta: 0, expensiveDelta: 0, priceConfigured: true },
      solar: {
        enabled: true,
        cheapDelta: 1,
        expensiveDelta: -1,
        priceConfigured: true,
        surplusWilling: true,
        surplusDelta: 2,
      },
    });
    const store = createPriceOptimizationSettingsStore(settings);

    expect(store.readSetup()).toEqual({
      state: 'resolved',
      setup: {
        enabled: false,
        configuredDeviceIds: ['disabled', 'solar'],
        solarSurplusDeviceIds: ['solar'],
      },
    });
  });

  it('does not turn a solar-only entry into an explicit Price choice', () => {
    const settings = new MockSettings();
    settings.set(PRICE_OPTIMIZATION_SETTINGS, {
      solarOnly: {
        enabled: false,
        cheapDelta: 0,
        expensiveDelta: 0,
        priceConfigured: false,
        surplusWilling: true,
        surplusDelta: 2,
      },
    });
    const store = createPriceOptimizationSettingsStore(settings);

    expect(store.readSetup()).toEqual({
      state: 'resolved',
      setup: {
        enabled: true,
        configuredDeviceIds: [],
        solarSurplusDeviceIds: ['solarOnly'],
      },
    });
  });

  it('preserves a legacy explicit Price opt-out that also uses solar surplus', () => {
    const settings = new MockSettings();
    settings.set(PRICE_OPTIMIZATION_SETTINGS, {
      legacy: {
        enabled: false,
        cheapDelta: 5,
        expensiveDelta: -5,
        surplusWilling: true,
        surplusDelta: 2,
      },
    });
    const store = createPriceOptimizationSettingsStore(settings);

    expect(store.readSetup()).toEqual({
      state: 'resolved',
      setup: {
        enabled: true,
        configuredDeviceIds: ['legacy'],
        solarSurplusDeviceIds: ['legacy'],
      },
    });
  });

  it.each([
    ['a listed malformed global toggle', PRICE_OPTIMIZATION_ENABLED, 'false'],
    ['a listed malformed device map', PRICE_OPTIMIZATION_SETTINGS, { heater: { enabled: false } }],
  ])('reports unavailable for %s', (_label, key, value) => {
    const settings = new MockSettings();
    settings.set(key, value);
    const store = createPriceOptimizationSettingsStore(settings);

    expect(store.readSetup()).toEqual({ state: 'unavailable' });
  });

  it('reports unavailable when the SDK key inventory throws', () => {
    const settings = new MockSettings();
    settings.set(PRICE_THRESHOLD_PERCENT, 25);
    settings.getKeys = () => { throw new Error('SDK unavailable'); };
    const store = createPriceOptimizationSettingsStore(settings);

    expect(store.readSetup()).toEqual({ state: 'unavailable' });
  });
});
