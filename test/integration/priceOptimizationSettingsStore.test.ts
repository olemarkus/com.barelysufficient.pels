import { describe, expect, it } from 'vitest';
import { createPriceOptimizationSettingsStore } from '../../lib/price/priceOptimizationSettingsStore';
import {
  PRICE_OPTIMIZATION_ENABLED,
  PRICE_OPTIMIZATION_SETTINGS,
  PRICE_THRESHOLD_PERCENT,
} from '../../lib/utils/settingsKeys';
import { MockSettings } from '../mocks/homey';
import { DEFAULT_SURPLUS_LIFT_C } from '../../packages/shared-domain/src/settings/priceOptimization';

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
          // The same lift the settings UI shows for an entry that stores none.
          surplusDelta: DEFAULT_SURPLUS_LIFT_C,
        },
      },
    });
  });

  it('resolves canonical defaults when price keys were never written', () => {
    const settings = new MockSettings();
    settings.set(PRICE_THRESHOLD_PERCENT, 25);
    const store = createPriceOptimizationSettingsStore(settings);

    expect(store.readSetup()).toEqual({
      state: 'resolved',
      setup: { enabled: true, configuredDeviceIds: [], solarSurplusDeviceIds: [] },
    });
    // An empty store has never written them either.
    expect(createPriceOptimizationSettingsStore(new MockSettings()).readSetup()).toEqual({
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

describe('createPriceOptimizationSettingsStore devicesFollowPrices', () => {
  const entry = (enabled: boolean) => ({ enabled, cheapDelta: 1, expensiveDelta: -1 });

  it('answers no on a fresh install and for explicit opt-outs', () => {
    expect(createPriceOptimizationSettingsStore(new MockSettings()).devicesFollowPrices()).toBe(false);
    const fresh = new MockSettings();
    fresh.set(PRICE_THRESHOLD_PERCENT, 25);
    expect(createPriceOptimizationSettingsStore(fresh).devicesFollowPrices()).toBe(false);

    const optedOut = new MockSettings();
    optedOut.set(PRICE_OPTIMIZATION_SETTINGS, { heater: entry(false) });
    expect(createPriceOptimizationSettingsStore(optedOut).devicesFollowPrices()).toBe(false);
  });

  it('answers yes when a device has Price on, unless Respond to prices is off', () => {
    const settings = new MockSettings();
    settings.set(PRICE_OPTIMIZATION_SETTINGS, { heater: entry(true) });
    const store = createPriceOptimizationSettingsStore(settings);
    expect(store.devicesFollowPrices()).toBe(true);

    settings.set(PRICE_OPTIMIZATION_ENABLED, false);
    expect(store.devicesFollowPrices()).toBe(false);
  });

  it('answers yes when the settings cannot be read', () => {
    const unlisted = new MockSettings();
    unlisted.getKeys = () => { throw new Error('SDK unavailable'); };
    expect(createPriceOptimizationSettingsStore(unlisted).devicesFollowPrices()).toBe(true);

    const malformed = new MockSettings();
    malformed.set(PRICE_OPTIMIZATION_SETTINGS, { heater: { enabled: 'yes' } });
    expect(createPriceOptimizationSettingsStore(malformed).devicesFollowPrices()).toBe(true);
  });
});
