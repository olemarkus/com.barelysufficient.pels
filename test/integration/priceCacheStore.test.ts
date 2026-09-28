import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createPriceCacheStore, importLegacyPriceCaches } from '../../lib/price/priceCacheStore';
import { createPriceDataStore } from '../../lib/price/priceDataStore';
import { IN_MEMORY_DATABASE, openUserdataDatabase } from '../../lib/store/userdataDatabase';
import {
  COMBINED_PRICES,
  ELECTRICITY_PRICES,
  ELECTRICITY_PRICES_AREA,
  FLOW_PRICES_TODAY,
  HOMEY_PRICES_CURRENCY,
  NETTLEIE_DATA,
  POWERHOUR_PRICES_DEVICE,
  POWERHOUR_PRICES_TOMORROW,
} from '../../lib/utils/settingsKeys';
import { MockSettings } from '../mocks/homey';

const open = () => {
  const db = openUserdataDatabase(IN_MEMORY_DATABASE);
  return { db, store: createPriceCacheStore(db) };
};

const totalChanges = (db: ReturnType<typeof open>['db']): number => (
  (db.prepare('SELECT total_changes() AS n').get() as { n: number }).n
);

const TARIFF = [
  { time: 0, energyFeeExVat: 11.9, energyFeeIncVat: 23.79, dateKey: '2026-09-27T00:00:00' },
  { time: 1, energyFeeExVat: 11.9, energyFeeIncVat: 23.79, dateKey: '2026-09-27T00:00:00' },
];

/** NVE's shape as it used to be stored: one row per hour per capacity step. */
const perStepRows = (hours: number, steps: number) => Array.from({ length: hours * steps }, (_, i) => ({
  time: Math.floor(i / steps),
  energyFeeExVat: 10 + Math.floor(i / steps),
  energyFeeIncVat: 12.5 + Math.floor(i / steps),
  fixedFeeExVat: 100 * (i % steps),
  fixedFeeIncVat: 125 * (i % steps),
  dateKey: '2026-09-27T00:00:00',
}));

describe('priceCacheStore', () => {
  it('answers null while empty and round-trips a cached value', () => {
    const { store } = open();
    expect(store.read('grid_tariff')).toBeNull();
    store.write('grid_tariff', TARIFF);
    expect(store.read('grid_tariff')).toEqual(TARIFF);
  });

  it('writes nothing for a value equal to the one held', () => {
    const { db, store } = open();
    store.write('grid_tariff', TARIFF);
    const changes = totalChanges(db);
    store.write('grid_tariff', structuredClone(TARIFF));
    expect(totalChanges(db)).toBe(changes);
  });

  it('keeps what it wrote across a reopen of the file', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pels-price-cache-'));
    const file = path.join(dir, 'pels.sqlite');
    try {
      const first = openUserdataDatabase(file);
      createPriceCacheStore(first).write('grid_tariff', TARIFF);
      first.close();
      const second = openUserdataDatabase(file);
      expect(createPriceCacheStore(second).read('grid_tariff')).toEqual(TARIFF);
      second.close();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('removes a cached value, so a read answers null, including from a fresh store on the same file', () => {
    const { db, store } = open();
    store.write('grid_tariff', TARIFF);
    store.remove('grid_tariff');
    expect(store.read('grid_tariff')).toBeNull();
    expect(createPriceCacheStore(db).read('grid_tariff')).toBeNull();
  });

  it('quarantines a row that does not parse, so it neither lingers nor blocks the next write', () => {
    const { db } = open();
    createPriceCacheStore(db).write('grid_tariff', TARIFF);
    db.prepare("UPDATE price_cache SET value_json = '{not json' WHERE key = 'grid_tariff'").run();
    const store = createPriceCacheStore(db);
    expect(store.read('grid_tariff')).toBeNull();
    expect((db.prepare('SELECT COUNT(*) AS n FROM price_cache').get() as { n: number }).n).toBe(0);
    store.write('grid_tariff', TARIFF);
    expect(createPriceCacheStore(db).read('grid_tariff')).toEqual(TARIFF);
  });
});

describe('importLegacyPriceCaches', () => {
  const rig = () => {
    const settings = new MockSettings();
    settings.set('boot_migrations_v1_ev_setting_cleanup_done', true);
    return { settings, ...open() };
  };

  it('imports the key one row per hour and retires it; a second boot has nothing to do', () => {
    const { settings, store } = rig();
    settings.set(NETTLEIE_DATA, perStepRows(24, 15));
    importLegacyPriceCaches(settings, store);
    const stored = store.read('grid_tariff') as Array<{ time: number; energyFeeExVat: number }>;
    expect(stored).toHaveLength(24);
    expect(stored.map((entry) => [entry.time, entry.energyFeeExVat])).toEqual(
      Array.from({ length: 24 }, (_, hour) => [hour, 10 + hour]),
    );
    expect(settings.get(NETTLEIE_DATA)).toBeNull();
    const get = vi.spyOn(settings, 'get');
    importLegacyPriceCaches(settings, store);
    expect(get).not.toHaveBeenCalled();
  });

  it('retires the key without reading it into a store that already holds a tariff', () => {
    const { settings, store } = rig();
    store.write('grid_tariff', TARIFF);
    settings.set(NETTLEIE_DATA, perStepRows(24, 15));
    importLegacyPriceCaches(settings, store);
    expect(store.read('grid_tariff')).toEqual(TARIFF);
    expect(settings.get(NETTLEIE_DATA)).toBeNull();
  });

  // The boot price refresh can store the static fallback before a deferred
  // import runs; a stopgap never outranks the real tariff the key still holds.
  it('adopts the key over a static fallback or an empty tariff the store holds', () => {
    const { settings, store } = rig();
    store.write('grid_tariff', [{ ...TARIFF[0], source: 'fallback' }]);
    settings.set(NETTLEIE_DATA, TARIFF);
    importLegacyPriceCaches(settings, store);
    expect(store.read('grid_tariff')).toEqual(TARIFF);
    expect(settings.get(NETTLEIE_DATA)).toBeNull();

    store.write('grid_tariff', []);
    settings.set(NETTLEIE_DATA, TARIFF);
    importLegacyPriceCaches(settings, store);
    expect(store.read('grid_tariff')).toEqual(TARIFF);
  });

  it('adopts an empty tariff as the empty tariff it is', () => {
    const { settings, store } = rig();
    settings.set(NETTLEIE_DATA, []);
    importLegacyPriceCaches(settings, store);
    expect(store.read('grid_tariff')).toEqual([]);
    expect(settings.get(NETTLEIE_DATA)).toBeNull();
  });

  it('leaves the key for the next boot on a suspect read or a value that is not a tariff', () => {
    const { settings, store } = rig();
    settings.set(NETTLEIE_DATA, 'garbage');
    importLegacyPriceCaches(settings, store);
    expect(settings.get(NETTLEIE_DATA)).toBe('garbage');
    settings.set(NETTLEIE_DATA, TARIFF);
    const originalGet = settings.get.bind(settings);
    const get = vi.spyOn(settings, 'get').mockImplementation((key) => (key === NETTLEIE_DATA ? undefined : originalGet(key)));
    importLegacyPriceCaches(settings, store);
    get.mockRestore();
    expect(store.read('grid_tariff')).toBeNull();
    importLegacyPriceCaches(settings, store);
    expect(store.read('grid_tariff')).toEqual(TARIFF);
    expect(settings.get(NETTLEIE_DATA)).toBeNull();
  });
});

describe('importLegacyPriceCaches: spot prices', () => {
  const SPOT = [
    { startsAt: '2026-09-27T00:00:00.000Z', spotPriceExVat: 55.1, currency: 'NOK' },
    { startsAt: '2026-09-27T01:00:00.000Z', spotPriceExVat: 51.3, currency: 'NOK' },
  ];
  const rig = () => {
    const settings = new MockSettings();
    settings.set('boot_migrations_v1_ev_setting_cleanup_done', true);
    return { settings, ...open() };
  };

  it('imports the spot prices and their area and retires both keys', () => {
    const { settings, store } = rig();
    settings.set(ELECTRICITY_PRICES, SPOT);
    settings.set(ELECTRICITY_PRICES_AREA, 'NO1');
    importLegacyPriceCaches(settings, store);
    expect(store.read('spot_prices')).toEqual(SPOT);
    expect(store.read('spot_price_area')).toBe('NO1');
    expect(settings.get(ELECTRICITY_PRICES)).toBeNull();
    expect(settings.get(ELECTRICITY_PRICES_AREA)).toBeNull();
  });

  it('retires the keys without reading them when the store already holds fetched prices', () => {
    const { settings, store } = rig();
    store.write('spot_prices', SPOT);
    store.write('spot_price_area', 'NO2');
    settings.set(ELECTRICITY_PRICES, [SPOT[0]]);
    settings.set(ELECTRICITY_PRICES_AREA, 'NO1');
    importLegacyPriceCaches(settings, store);
    expect(store.read('spot_prices')).toEqual(SPOT);
    expect(store.read('spot_price_area')).toBe('NO2');
    expect(settings.get(ELECTRICITY_PRICES)).toBeNull();
    expect(settings.get(ELECTRICITY_PRICES_AREA)).toBeNull();
  });

  it('leaves a key that holds nothing usable for the next boot', () => {
    const { settings, store } = rig();
    settings.set(ELECTRICITY_PRICES, { not: 'a list' });
    settings.set(ELECTRICITY_PRICES_AREA, '');
    importLegacyPriceCaches(settings, store);
    expect(store.read('spot_prices')).toBeNull();
    expect(store.read('spot_price_area')).toBeNull();
    expect(settings.get(ELECTRICITY_PRICES)).toEqual({ not: 'a list' });
    expect(settings.get(ELECTRICITY_PRICES_AREA)).toBe('');
  });
});

describe('importLegacyPriceCaches: payload-fed sources', () => {
  const PAYLOAD = { dateKey: '2026-09-27', pricesByHour: { 0: 1.2 }, updatedAt: '2026-09-27T00:00:00.000Z' };
  const rig = () => {
    const settings = new MockSettings();
    settings.set('boot_migrations_v1_ev_setting_cleanup_done', true);
    return { settings, ...open() };
  };

  it('imports day payloads and markers into rows of the same name and retires the keys', () => {
    const { settings, store } = rig();
    settings.set(FLOW_PRICES_TODAY, PAYLOAD);
    settings.set(HOMEY_PRICES_CURRENCY, 'NOK');
    settings.set(POWERHOUR_PRICES_DEVICE, 'no2-device');
    importLegacyPriceCaches(settings, store);
    expect(store.read(FLOW_PRICES_TODAY)).toEqual(PAYLOAD);
    expect(store.read(HOMEY_PRICES_CURRENCY)).toBe('NOK');
    expect(store.read(POWERHOUR_PRICES_DEVICE)).toBe('no2-device');
    for (const key of [FLOW_PRICES_TODAY, HOMEY_PRICES_CURRENCY, POWERHOUR_PRICES_DEVICE]) {
      expect(settings.getKeys()).not.toContain(key);
    }
  });

  // A listed key reading back null may be a transient miss, so it is not
  // retired on that read alone; once the store holds a newer row, it is.
  it('defers a key that reads back null, and retires it unread once the store holds a newer row', () => {
    const { settings, store } = rig();
    settings.set(POWERHOUR_PRICES_TOMORROW, null);
    importLegacyPriceCaches(settings, store);
    expect(settings.getKeys()).toContain(POWERHOUR_PRICES_TOMORROW);
    expect(store.read(POWERHOUR_PRICES_TOMORROW)).toBeNull();

    store.write(POWERHOUR_PRICES_TOMORROW, PAYLOAD);
    const get = vi.spyOn(settings, 'get');
    importLegacyPriceCaches(settings, store);
    expect(get).not.toHaveBeenCalledWith(POWERHOUR_PRICES_TOMORROW);
    expect(settings.getKeys()).not.toContain(POWERHOUR_PRICES_TOMORROW);
    expect(store.read(POWERHOUR_PRICES_TOMORROW)).toEqual(PAYLOAD);
  });

  it('leaves a key that reads back undefined for the next boot', () => {
    const { settings, store } = rig();
    settings.set(FLOW_PRICES_TODAY, PAYLOAD);
    const originalGet = settings.get.bind(settings);
    const get = vi.spyOn(settings, 'get').mockImplementation((key) => (key === FLOW_PRICES_TODAY ? undefined : originalGet(key)));
    importLegacyPriceCaches(settings, store);
    get.mockRestore();
    expect(settings.getKeys()).toContain(FLOW_PRICES_TODAY);
    expect(store.read(FLOW_PRICES_TODAY)).toBeNull();
  });
});

describe('importLegacyPriceCaches: combined prices', () => {
  const V2 = {
    version: 2,
    days: { '2026-09-27': { hours: [{ startsAt: '2026-09-26T22:00:00.000Z', total: 1, isCheap: false, isExpensive: false }] } },
    avgPrice: 1, lowThreshold: 0.5, highThreshold: 1.5, priceScheme: 'norway', priceUnit: 'NOK/kWh',
  };
  const V1 = { prices: [{ startsAt: '2026-09-26T22:00:00.000Z', total: 1 }], avgPrice: 1 };
  const rig = () => {
    const settings = new MockSettings();
    settings.set('boot_migrations_v1_ev_setting_cleanup_done', true);
    return { settings, ...open() };
  };

  it('imports the combined prices as they are, a legacy V1 shape included, and retires the key', () => {
    for (const legacy of [V2, V1]) {
      const { settings, store } = rig();
      settings.set(COMBINED_PRICES, legacy);
      importLegacyPriceCaches(settings, store);
      expect(store.read(COMBINED_PRICES)).toEqual(legacy);
      expect(settings.getKeys()).not.toContain(COMBINED_PRICES);
    }
  });

  it('retires the key unread once the store holds a build of its own', () => {
    const { settings, store } = rig();
    store.write(COMBINED_PRICES, V2);
    settings.set(COMBINED_PRICES, V1);
    importLegacyPriceCaches(settings, store);
    expect(store.read(COMBINED_PRICES)).toEqual(V2);
    expect(settings.getKeys()).not.toContain(COMBINED_PRICES);
  });

  it('imports a key the boot read missed on the first read that finds no row', () => {
    const { settings, store } = rig();
    settings.set(COMBINED_PRICES, V2);
    const originalGet = settings.get.bind(settings);
    const get = vi.spyOn(settings, 'get').mockImplementation((key) => (key === COMBINED_PRICES ? undefined : originalGet(key)));
    importLegacyPriceCaches(settings, store);
    get.mockRestore();
    expect(settings.getKeys()).toContain(COMBINED_PRICES);

    expect(createPriceDataStore(settings, store).readCombinedRaw()).toEqual(V2);
    expect(settings.getKeys()).not.toContain(COMBINED_PRICES);
  });
});
