import type { SettingsPort } from '../ports/homeyRuntime';
import {
  COMBINED_PRICES,
  ELECTRICITY_PRICES,
  ELECTRICITY_PRICES_AREA,
  HOMEY_PRICES_CURRENCY,
  NETTLEIE_DATA,
  POWERHOUR_PRICES_CURRENCY,
  POWERHOUR_PRICES_DEVICE,
  POWERHOUR_PRICES_TODAY,
  POWERHOUR_PRICES_TOMORROW,
} from '../utils/settingsKeys';
import type { SpotPriceEntry } from './spotPriceFetch';
import {
  DEFAULT_PERIOD_MINUTES,
  type FlowPricePayload,
  type FlowPricePeriod,
} from '../../packages/shared-domain/src/price/flowPriceUtils';
import { readPowerhourDeviceIdSetting } from '../../packages/shared-domain/src/settings/priceScheme';
import type {
  PowerhourCache, PowerhourCacheDevice, PowerhourCachedDay, PowerhourDay,
} from './powerhourScheme';
import type { CombinedPricesV2 } from './priceTypes';

/**
 * The persisted form of a priced period. The duration is omitted when the
 * period is an hour long, because that is exactly what the read boundary gives
 * a period that carries none (`normalizeFlowSlotEntries`), and because the SDK
 * ships the whole settings object on every write of any key — so an hourly
 * source stores what it always stored, and only a sub-hourly source pays the
 * bytes for saying how long its periods are.
 */
type StoredFlowPricePeriod = {
  startsAt: string;
  totalPrice: number;
  durationMinutes?: number;
};

type StoredFlowPricePayload = Omit<FlowPricePayload, 'pricesBySlot' | 'pricesByPeriod'> & {
  pricesBySlot?: StoredFlowPricePeriod[];
  pricesByPeriod?: StoredFlowPricePeriod[];
};

const toStoredPeriods = (periods: FlowPricePeriod[]): StoredFlowPricePeriod[] => (
  periods.map(({ startsAt, totalPrice, durationMinutes }) => (
    durationMinutes === DEFAULT_PERIOD_MINUTES
      ? { startsAt, totalPrice }
      : { startsAt, totalPrice, durationMinutes }
  ))
);

const toStoredFlowPayload = (payload: FlowPricePayload | null): StoredFlowPricePayload | null => {
  if (!payload) return payload;
  return {
    ...payload,
    ...(payload.pricesBySlot ? { pricesBySlot: toStoredPeriods(payload.pricesBySlot) } : {}),
    ...(payload.pricesByPeriod ? { pricesByPeriod: toStoredPeriods(payload.pricesByPeriod) } : {}),
  };
};

/**
 * One Power by the Hour cache key, resolved.
 *
 * The `getKeys()` cross-check is what makes this more than a `settings.get`:
 * the Power by the Hour source MERGES into the day it already holds, so
 * "nothing came back" has to be told apart from "nothing is there". Absence
 * stays with the caller, as `notes/settings-key-ownership.md` requires — this
 * IS the caller, and it is the side that can ask `getKeys()`.
 *
 * `null` is ABSENCE, not a failed read: it is precisely what the SDK's
 * `ManagerSettings.get()` answers for a key that was never written or was
 * `unset`. Only a key the store still LISTS while answering `undefined` is
 * inconsistent enough to settle nothing. Reading a listed `null` as unreadable
 * is what broke the SHS test Homey — a day cleared on a device change was
 * stored as `null`, every later pass called it unreadable and refused to write,
 * and the home never got prices again.
 */
const readCachedDay = (settings: SettingsPort, key: string): PowerhourCachedDay => {
  const value = settings.get(key);
  if (value !== undefined && value !== null) return { kind: 'stored', payload: value };
  if (value === undefined && settings.getKeys().includes(key)) return { kind: 'unreadable' };
  return { kind: 'absent' };
};

const readCacheDevice = (settings: SettingsPort): PowerhourCacheDevice => {
  const value = settings.get(POWERHOUR_PRICES_DEVICE);
  const deviceId = readPowerhourDeviceIdSetting(value);
  if (deviceId !== null) return { kind: 'device', deviceId };
  // Same rule as a day: only a listed key answering `undefined` settles nothing.
  if (value === undefined && settings.getKeys().includes(POWERHOUR_PRICES_DEVICE)) {
    return { kind: 'unreadable' };
  }
  return { kind: 'absent' };
};

const readPowerhourCacheFrom = (settings: SettingsPort): PowerhourCache => ({
  today: readCachedDay(settings, POWERHOUR_PRICES_TODAY),
  tomorrow: readCachedDay(settings, POWERHOUR_PRICES_TOMORROW),
  device: readCacheDevice(settings),
});

/**
 * Producer-side typed boundary for PriceService's cached price-data settings
 * (spot prices, grid tariff, the flow/homey/powerhour flow-price slot payloads,
 * and the homey- and powerhour-prices currencies). Writes are typed so a wrong shape can't be persisted;
 * reads return the raw persisted value (callers validate/cast as before). The
 * flow methods are keyed because the same purge path serves both the
 * FLOW_PRICES_* and HOMEY_PRICES_* slot pairs.
 *
 * It also owns the COMBINED_PRICES producer read-back/write that PriceService
 * uses when rebuilding the cache. `readCombinedRaw` returns the persisted
 * COMBINED_PRICES value verbatim — un-migrated and un-pruned — because
 * PriceService fingerprints it and runs the transient-read data-safety guard
 * against the raw bytes (migration/pruning is the separate combined-prices
 * reader's job for consumers). `writeCombined` persists the freshly-built V2
 * payload.
 */
export type PriceDataStore = {
  readSpotPrices(): unknown;
  writeSpotPrices(prices: SpotPriceEntry[]): void;
  readSpotPriceArea(): unknown;
  writeSpotPriceArea(area: string): void;
  readNettleie(): unknown;
  writeNettleie(data: Array<Record<string, unknown>>): void;
  readFlowPayload(key: string): unknown;
  writeFlowPayload(key: string, payload: FlowPricePayload | null): void;
  writeHomeyPricesCurrency(unit: string): void;
  writePowerhourCurrency(unit: string | null): void;
  /** Everything already stored from the Power by the Hour source, as one concept. */
  readPowerhourCache(): PowerhourCache;
  writePowerhourDay(day: PowerhourDay, payload: FlowPricePayload | null): void;
  writePowerhourCacheDevice(deviceId: string | null): void;
  readCombinedRaw(): unknown;
  writeCombined(payload: CombinedPricesV2): void;
};

/**
 * The settings-backed {@link PriceDataStore}. It lives beside the port it
 * implements because the reads and the keys they use are the price module's
 * own: `setup/` hands over a {@link SettingsPort} and knows nothing about which
 * keys back which field.
 */
export const createPriceDataStore = (settings: SettingsPort): PriceDataStore => ({
  readSpotPrices: () => settings.get(ELECTRICITY_PRICES),
  writeSpotPrices: (prices) => settings.set(ELECTRICITY_PRICES, prices),
  readSpotPriceArea: () => settings.get(ELECTRICITY_PRICES_AREA),
  writeSpotPriceArea: (area) => settings.set(ELECTRICITY_PRICES_AREA, area),
  readNettleie: () => settings.get(NETTLEIE_DATA),
  writeNettleie: (data) => settings.set(NETTLEIE_DATA, data),
  readFlowPayload: (key) => settings.get(key),
  writeFlowPayload: (key, payload) => settings.set(key, toStoredFlowPayload(payload)),
  writeHomeyPricesCurrency: (unit) => settings.set(HOMEY_PRICES_CURRENCY, unit),
  writePowerhourCurrency: (unit) => (
    unit === null ? settings.unset(POWERHOUR_PRICES_CURRENCY) : settings.set(POWERHOUR_PRICES_CURRENCY, unit)
  ),
  readPowerhourCache: () => readPowerhourCacheFrom(settings),
  writePowerhourDay: (day, payload) => {
    const key = day === 'today' ? POWERHOUR_PRICES_TODAY : POWERHOUR_PRICES_TOMORROW;
    // REMOVE the key rather than storing `null`. `settings.set(key, null)` leaves
    // the key LISTED, and a listed key that reads back empty is exactly how
    // `readCachedDay` recognises a transient miss — so a day cleared on purpose
    // would come back as `unreadable` on every later pass, and the source would
    // never store that day again. Seen on the SHS test Homey: clearing the price
    // device left the home permanently unpriced.
    if (payload === null) settings.unset(key);
    else settings.set(key, toStoredFlowPayload(payload));
  },
  // Same rule for the marker: no device is no key, never an empty string that a
  // later read has to interpret.
  writePowerhourCacheDevice: (deviceId) => (
    deviceId === null ? settings.unset(POWERHOUR_PRICES_DEVICE) : settings.set(POWERHOUR_PRICES_DEVICE, deviceId)
  ),
  readCombinedRaw: () => settings.get(COMBINED_PRICES),
  writeCombined: (payload) => settings.set(COMBINED_PRICES, payload),
});
