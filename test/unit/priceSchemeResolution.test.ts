import { describe, expect, it } from 'vitest';
import { PriceSchemeResolver } from '../../lib/price/priceSchemeResolution';
import type { SettingsPort } from '../../lib/ports/homeyRuntime';
import { EXPORT_FIXED, EXPORT_PRICE_ENABLED, PRICE_SCHEME } from '../../lib/utils/settingsKeys';

type FakeSettings = SettingsPort & {
  values: Record<string, unknown>;
  unreadable: Set<string>;
  keysUnavailable: boolean;
  writesFail: boolean;
};

/**
 * A settings store where a key can be LISTED yet read back empty, where the
 * key list itself can fail, and where writes can fail: the transient misses
 * the resolver must not read as an owner's choice or a settled export price.
 */
const fakeSettings = (values: Record<string, unknown>): FakeSettings => {
  const settings: FakeSettings = {
    values,
    unreadable: new Set(),
    keysUnavailable: false,
    writesFail: false,
    get: (key) => (settings.unreadable.has(key) ? undefined : settings.values[key]),
    set: (key, value) => {
      if (settings.writesFail) throw new Error('settings write failed');
      settings.values[key] = value;
    },
    unset: (key) => { delete settings.values[key]; },
    getKeys: () => (settings.keysUnavailable ? [] : [...Object.keys(settings.values), ...settings.unreadable]),
  };
  return settings;
};

const fakeStore = (cachedResolution: unknown = null) => {
  const store = {
    cachedResolution,
    writesFail: false,
    readPriceSchemeResolution: () => store.cachedResolution,
    writePriceSchemeResolution: (resolution: unknown) => {
      if (store.writesFail) throw new Error('cache write failed');
      store.cachedResolution = resolution;
    },
  };
  return store;
};

// Every PELS install has some settings keys; an empty list is the SDK's miss.
const OTHER_KEYS = { capacity_limit_kw: 8 };

const NL = { state: 'resolved', country: 'NL' } as const;
const NO = { state: 'resolved', country: 'NO' } as const;
const NO_ANSWER = { state: 'unavailable' } as const;

const HOMEY_IN_NL = { scheme: 'homey', basis: { kind: 'hub_location', country: 'NL' } };
const NORWAY_DEFAULT = { scheme: 'norway', basis: { kind: 'default' } };

// Entered while the home ran on the Norway source, so -5 means øre/kWh.
const ORE_EXPORT_PRICE = { [EXPORT_PRICE_ENABLED]: true, [EXPORT_FIXED]: -5 };

describe('PriceSchemeResolver', () => {
  it('runs on the Norway source while it knows neither a choice nor the hub country', () => {
    const resolver = new PriceSchemeResolver(fakeSettings({ ...OTHER_KEYS }), fakeStore());

    expect(resolver.resolve()).toEqual(NORWAY_DEFAULT);
  });

  it('switches a hub outside Norway to Homey Energy when the owner never chose a source', () => {
    const store = fakeStore();
    const resolver = new PriceSchemeResolver(fakeSettings({ ...OTHER_KEYS }), store);

    expect(resolver.refresh(NL)).toEqual({ kind: 'switched', resolution: HOMEY_IN_NL, exportPlan: 'none' });
    expect(resolver.resolve()).toEqual(HOMEY_IN_NL);
    expect(store.cachedResolution).toEqual(HOMEY_IN_NL);
  });

  it('assumes the Norway source for a hub in Norway', () => {
    const resolver = new PriceSchemeResolver(fakeSettings({ ...OTHER_KEYS }), fakeStore());

    // Same source as the default, so nothing to refetch.
    expect(resolver.refresh(NO)).toEqual({ kind: 'none' });
    expect(resolver.resolve()).toEqual({ scheme: 'norway', basis: { kind: 'hub_location', country: 'NO' } });
  });

  it('keeps the owner\'s saved source whatever country the hub is in', () => {
    const resolver = new PriceSchemeResolver(fakeSettings({ ...OTHER_KEYS, [PRICE_SCHEME]: 'norway' }), fakeStore());

    expect(resolver.refresh(NL)).toEqual({ kind: 'none' });
    expect(resolver.resolve()).toEqual({ scheme: 'norway', basis: { kind: 'chosen' } });
  });

  it('applies a source the owner saves at once', () => {
    // The settings UI settled the export price before saving it.
    const settings = fakeSettings({ ...OTHER_KEYS });
    const resolver = new PriceSchemeResolver(settings, fakeStore(HOMEY_IN_NL));

    settings.values[PRICE_SCHEME] = 'norway';

    expect(resolver.resolve()).toEqual({ scheme: 'norway', basis: { kind: 'chosen' } });
  });

  it('keeps a Norwegian owner on the Norway source they set up, whatever country the hub reports', () => {
    // The Norway form never writes the source key itself, so this owner's grid
    // company is their only record of choosing Norway. A hub placed in the
    // wrong country must not move them to Homey Energy.
    const settings = fakeSettings({ ...OTHER_KEYS, nettleie_orgnr: '979151950' });
    const resolver = new PriceSchemeResolver(settings, fakeStore());

    expect(resolver.refresh({ state: 'resolved', country: 'SE' })).toEqual({ kind: 'none' });
    expect(resolver.resolve()).toEqual({ scheme: 'norway', basis: { kind: 'chosen' } });
  });

  it('boots on the source last in force rather than on Norwegian prices', () => {
    // Before Homey reports the hub's country, and also when the first settings
    // reads fail, the cached source is what this home was running on.
    const settings = fakeSettings({ ...OTHER_KEYS });
    const resolver = new PriceSchemeResolver(settings, fakeStore(HOMEY_IN_NL));
    expect(resolver.resolve()).toEqual(HOMEY_IN_NL);

    settings.keysUnavailable = true;

    expect(resolver.resolve()).toEqual(HOMEY_IN_NL);
  });

  it('ignores a cached source it cannot vouch for', () => {
    const resolver = new PriceSchemeResolver(
      fakeSettings({ ...OTHER_KEYS }),
      fakeStore({ scheme: 'homey', basis: { kind: 'hub_location', country: 'nowhere' } }),
    );

    expect(resolver.resolve()).toEqual(NORWAY_DEFAULT);
  });

  it('changes nothing when Homey does not answer where the hub is', () => {
    const resolver = new PriceSchemeResolver(fakeSettings({ ...OTHER_KEYS }), fakeStore(HOMEY_IN_NL));

    expect(resolver.refresh(NO_ANSWER)).toEqual({ kind: 'none' });
    expect(resolver.resolve()).toEqual(HOMEY_IN_NL);
  });

  it('keeps the source in force through a scheme key that reads back empty', () => {
    const settings = fakeSettings({ ...OTHER_KEYS, [PRICE_SCHEME]: 'homey' });
    const resolver = new PriceSchemeResolver(settings, fakeStore());
    resolver.refresh(NO);
    expect(resolver.resolve()).toEqual({ scheme: 'homey', basis: { kind: 'chosen' } });

    // Listed, so it was written: a miss is not the owner un-choosing it, and
    // assuming Norway from the hub's country here would switch the source.
    settings.unreadable.add(PRICE_SCHEME);

    expect(resolver.refresh(NO)).toEqual({ kind: 'none' });
    expect(resolver.resolve()).toEqual({ scheme: 'homey', basis: { kind: 'chosen' } });
  });

  it('keeps the source in force when the key list cannot be read', () => {
    const settings = fakeSettings({ ...OTHER_KEYS });
    settings.keysUnavailable = true;
    const resolver = new PriceSchemeResolver(settings, fakeStore(HOMEY_IN_NL));

    expect(resolver.refresh(NO)).toEqual({ kind: 'none' });
    expect(resolver.resolve()).toEqual(HOMEY_IN_NL);
  });

  it('switches only on a refresh, settling the export price, after the settings store recovers', () => {
    const settings = fakeSettings({ ...OTHER_KEYS, ...ORE_EXPORT_PRICE });
    settings.keysUnavailable = true;
    const resolver = new PriceSchemeResolver(settings, fakeStore());
    expect(resolver.refresh(NL)).toEqual({ kind: 'none' });

    // The settings store answers again: reading the source must not move it
    // past an export price still entered in øre.
    settings.keysUnavailable = false;
    expect(resolver.resolve()).toEqual(NORWAY_DEFAULT);

    expect(resolver.refresh(NO_ANSWER))
      .toEqual({ kind: 'switched', resolution: HOMEY_IN_NL, exportPlan: 'disable_export' });
    expect(settings.values[EXPORT_PRICE_ENABLED]).toBe(false);
    expect(resolver.resolve()).toEqual(HOMEY_IN_NL);
  });

  it('holds the switch while a saved export amount reads back empty', () => {
    // Read as 0, the øre amount would look like no fixed amount at all and
    // stay enabled, a hundred times too large in Homey Energy's currency.
    const settings = fakeSettings({ ...OTHER_KEYS, ...ORE_EXPORT_PRICE });
    settings.unreadable.add(EXPORT_FIXED);
    const resolver = new PriceSchemeResolver(settings, fakeStore());

    expect(resolver.refresh(NL)).toEqual({ kind: 'held', resolution: HOMEY_IN_NL });
    expect(resolver.resolve()).toEqual(NORWAY_DEFAULT);
    expect(settings.values[EXPORT_PRICE_ENABLED]).toBe(true);

    settings.unreadable.delete(EXPORT_FIXED);

    expect(resolver.refresh(NO_ANSWER))
      .toEqual({ kind: 'switched', resolution: HOMEY_IN_NL, exportPlan: 'disable_export' });
  });

  it('keeps the source in force when turning the export price off fails', () => {
    const settings = fakeSettings({ ...OTHER_KEYS, ...ORE_EXPORT_PRICE });
    settings.writesFail = true;
    const resolver = new PriceSchemeResolver(settings, fakeStore());

    expect(() => resolver.refresh(NL)).toThrow('settings write failed');
    expect(resolver.resolve()).toEqual(NORWAY_DEFAULT);

    settings.writesFail = false;

    expect(resolver.refresh(NO_ANSWER))
      .toEqual({ kind: 'switched', resolution: HOMEY_IN_NL, exportPlan: 'disable_export' });
  });

  it('retries a failed cache write on the next refresh', () => {
    const store = fakeStore();
    store.writesFail = true;
    const resolver = new PriceSchemeResolver(fakeSettings({ ...OTHER_KEYS }), store);
    resolver.refresh(NL);
    expect(store.cachedResolution).toBeNull();

    store.writesFail = false;
    resolver.refresh(NL);

    expect(store.cachedResolution).toEqual(HOMEY_IN_NL);
  });
});
