import Homey from 'homey';
import {
  getDateKeyInTimeZone,
  getHourStartInTimeZone,
} from '../utils/dateUtils';
import {
  COMBINED_PRICES,
  FLOW_PRICES_TODAY,
  FLOW_PRICES_TOMORROW,
  HOMEY_PRICES_CURRENCY,
  HOMEY_PRICES_TODAY,
  HOMEY_PRICES_TOMORROW,
  NORWAY_PRICE_MODEL,
  PRICE_SCHEME,
} from '../utils/settingsKeys';
import {
  addDays,
  fetchGridTariffWithDateFallback,
  getSpotPriceCacheDecision,
  getSpotPriceDates,
} from './priceServiceUtils';
import { getFlowPricePayload } from './flowPriceUtils';
import { shouldUseGridTariffCache } from './gridTariffUtils';
import { resolveGridTariffFallback } from './staticGridTariffFallback';
import { NETTLEIE_FALLBACK_GENERATED_AT } from './nettleieFallbackData.generated';
import {
  buildHomeyEnergyDateInfo,
  fetchHomeyEnergyResults,
  logHomeyEnergyPayloadStatus,
  shouldUseHomeyEnergyCache,
  storeHomeyEnergyPayloads,
  updateHomeyEnergyCurrency,
} from './homeyEnergyRefresh';
import {
  buildCombinedHourlyPricesFromPayloads,
  purgeStaleFlowPriceSlots,
  storeFlowPriceData as storeFlowPriceDataHelper,
  type FlowSlotChange,
} from './priceServiceFlowHelpers';
import type { StructuredDebugEmitter } from '../logging/logger';
import type { FlowPricePayload } from './flowPriceUtils';
import {
  buildCombinedPricePayload,
  combinedRebuildLostActionableEntries,
  getCombinedPayloadLastFetched,
  toCombinedPayloadFingerprint,
} from './priceServiceCombined';
import {
  getCurrentMonthUsageKwh,
  getHourlyUsageEstimateKwh,
} from './priceServiceNorgespris';
import { buildCombinedHourlyPricesNorway } from './priceServiceNorway';
import { fetchSpotPricesForDate } from './spotPriceFetch';
import { getCurrentHourPrice, isCurrentHourAtLevel } from './priceLevelUtils';
import { formatFlowPriceInfo, formatNorwayPriceInfo } from './priceInfoFormatters';
import type { CombinedHourlyPrice, PriceScheme } from './priceTypes';
import type { HomeyEnergyApi } from '../utils/homeyEnergy';

const GRID_TARIFF_FAILURE_REASONS: Record<'keepCache' | 'clearStaleFallback' | 'noData', string> = {
  keepCache: 'Keeping cached tariff data (NVE returned empty list)',
  clearStaleFallback: 'Cleared stale fallback (NVE unavailable, no static fallback for current operator)',
  noData: 'NVE unavailable and no static fallback for this operator',
};

export default class PriceService {
  constructor(
    private homey: Homey.App['homey'],
    private log: (...args: unknown[]) => void,
    private debugStructured: StructuredDebugEmitter,
    private errorLog?: (...args: unknown[]) => void,
    private getHomeyEnergyApi?: () => HomeyEnergyApi | null,
  ) { }

  private onCombinedPricesUpdated?: (reason: string) => void;
  setOnCombinedPricesUpdated(listener: ((reason: string) => void) | undefined): void {
    this.onCombinedPricesUpdated = listener;
  }
  private getSettingValue(key: string): unknown { return this.homey.settings.get(key) as unknown; }
  private getNumberSetting(key: string, fallback: number): number {
    const value = this.getSettingValue(key);
    return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
  }
  private emitRealtime(event: string, payload: unknown): void {
    const api = (this.homey as { api?: { realtime?: (evt: string, data: unknown) => Promise<void> } }).api;
    if (!api?.realtime) return;
    api.realtime(event, payload).catch((err) => this.errorLog?.('Failed to emit realtime event', event, err));
  }

  // Public so the coordinator can gate boot-time work on the active scheme
  // (e.g. the flow-only combined-prices catch-up) without re-deriving the
  // PRICE_SCHEME→scheme mapping. Single source of truth for the early-returns
  // in refreshSpotPrices/getCombinedHourlyPrices.
  getPriceScheme(): PriceScheme {
    const raw = this.getSettingValue(PRICE_SCHEME);
    if (raw === 'flow' || raw === 'homey') return raw;
    return 'norway';
  }

  // Public so app-level callers (e.g. the deferred-objective plan-preview cost
  // estimate) can label a currency without re-deriving the scheme→unit mapping.
  getPriceUnitLabel(): string {
    const scheme = this.getPriceScheme();
    if (scheme === 'norway') return 'øre/kWh';
    if (scheme === 'homey') {
      const currency = this.getSettingValue(HOMEY_PRICES_CURRENCY);
      return typeof currency === 'string' && currency.trim() ? currency : 'price units';
    }
    return 'price units';
  }

  private shouldUseSpotPriceCache(params: {
    forceRefresh: boolean;
    cachedArea: unknown;
    priceArea: string;
    today: Date;
    dates: { todayStr: string; tomorrowStr: string };
  }): boolean {
    const { forceRefresh, cachedArea, priceArea, today, dates } = params;
    if (forceRefresh) return false;
    const existingPrices = this.getSettingValue('electricity_prices') as Array<{ startsAt?: string }> | null;
    const cacheDecision = getSpotPriceCacheDecision({
      cachedArea,
      priceArea,
      existingPrices,
      dates,
      now: today,
    });
    if (cacheDecision.areaChanged) {
      this.debugStructured({ event: 'spot_price_area_changed', fromArea: cachedArea, toArea: priceArea });
    }
    if (cacheDecision.useCache) {
      this.debugStructured({ event: 'spot_price_cache_used', entryCount: existingPrices?.length ?? 0 });
      this.updateCombinedPrices();
      return true;
    }
    if (cacheDecision.shouldFetchTomorrow) {
      this.debugStructured({ event: 'spot_price_refresh_for_tomorrow' });
    }
    return false;
  }
  async refreshSpotPrices(forceRefresh = false): Promise<void> {
    const scheme = this.getPriceScheme();
    if (scheme === 'flow') {
      this.debugStructured({ event: 'spot_price_refresh_skipped', reason: 'flow_scheme_active' });
      return;
    }
    if (scheme === 'homey') {
      await this.refreshHomeyEnergyPrices(forceRefresh);
      return;
    }
    const priceArea = this.getPriceArea();
    const cachedArea = this.getSettingValue('electricity_prices_area');
    const today = new Date();
    const dates = getSpotPriceDates(today);

    if (this.shouldUseSpotPriceCache({
      forceRefresh,
      cachedArea,
      priceArea,
      today,
      dates,
    })) {
      return;
    }

    const todayPrices = await fetchSpotPricesForDate({
      date: today,
      priceArea,
      log: this.log,
      debugStructured: this.debugStructured,
      errorLog: this.errorLog,
    });
    const tomorrowPrices = await fetchSpotPricesForDate({
      date: addDays(today, 1),
      priceArea,
      log: this.log,
      debugStructured: this.debugStructured,
      errorLog: this.errorLog,
    });
    const allPrices = [...todayPrices, ...tomorrowPrices];
    if (allPrices.length === 0) {
      this.log('Spot prices: No price data available');
      return;
    }
    this.homey.settings.set('electricity_prices', allPrices);
    this.homey.settings.set('electricity_prices_area', priceArea);
    this.log(`Spot prices: Stored ${allPrices.length} hourly prices for ${priceArea}`);
    this.updateCombinedPrices();
  }
  async refreshGridTariffData(forceRefresh = false): Promise<void> {
    if (this.getPriceScheme() !== 'norway') {
      this.debugStructured({ event: 'grid_tariff_refresh_skipped', reason: 'non_norway_scheme' });
      return;
    }
    const settings = this.getGridTariffSettings();
    if (!settings.organizationNumber) {
      this.log('Grid tariff: No organization number configured, skipping fetch');
      return;
    }
    const requestSettings: { countyCode: string; organizationNumber: string; tariffGroup: string } = {
      countyCode: settings.countyCode,
      organizationNumber: settings.organizationNumber,
      tariffGroup: settings.tariffGroup,
    };

    const todayDate = new Date();
    const timeZone = this.homey.clock.getTimezone();
    const today = getDateKeyInTimeZone(todayDate, timeZone);
    const existingData = this.getSettingValue('nettleie_data') as
      Array<{ dateKey?: string; datoId?: string; source?: unknown }> | null;
    if (!forceRefresh && shouldUseGridTariffCache(existingData, today, this.debugStructured)) {
      this.updateCombinedPrices();
      return;
    }

    const { data, attempts, logContext } = await fetchGridTariffWithDateFallback({
      settings: requestSettings,
      todayDate,
      timeZone,
      log: this.log,
      errorLog: this.errorLog,
    });
    if (data) {
      this.storeGridTariffData(data, logContext);
      return;
    }

    // All NVE attempts failed. Keep real cached data if any; otherwise — a new
    // user with nothing cached — seed the static fallback so prices still work
    // until NVE recovers. The fallback is flagged so it never suppresses the
    // next NVE retry (see shouldUseGridTariffCache).
    const outcome = resolveGridTariffFallback({
      existingData,
      organizationNumber: requestSettings.organizationNumber,
      tariffGroup: requestSettings.tariffGroup,
      date: todayDate,
      timeZone,
    });
    if (outcome.kind === 'store') {
      this.storeGridTariffData(
        outcome.entries,
        ` (static fallback — NVE unavailable, no cached tariff; snapshot ${NETTLEIE_FALLBACK_GENERATED_AT})`,
      );
      return;
    }
    if (outcome.kind === 'fallbackCurrent') {
      // Fallback already matches today; recompute combined prices in memory but
      // skip the redundant settings write (flash wear) while NVE stays down.
      this.updateCombinedPrices();
      return;
    }
    if (outcome.kind === 'clearStaleFallback') {
      // The cached data is a stale fallback for an operator we can no longer
      // serve (e.g. the org number changed). Clear it so combined prices don't
      // keep using another operator's tariff.
      this.homey.settings.set('nettleie_data', []);
      this.updateCombinedPrices();
    }
    this.errorLog?.(`Grid tariff: ${GRID_TARIFF_FAILURE_REASONS[outcome.kind]}`, {
      attempts,
      countyCode: requestSettings.countyCode,
      organizationNumber: requestSettings.organizationNumber,
      tariffGroup: requestSettings.tariffGroup,
    });
  }

  private storeGridTariffData(data: Array<Record<string, unknown>>, logContext: string): void {
    this.homey.settings.set('nettleie_data', data);
    this.log(`Grid tariff: Stored ${data.length} hourly tariff entries${logContext}`);
    this.updateCombinedPrices();
  }

  updateCombinedPrices(): void {
    const now = new Date();
    const timeZone = this.homey.clock.getTimezone();
    const combined = this.getCombinedHourlyPrices();
    const payload = buildCombinedPricePayload({
      combined,
      priceScheme: this.getPriceScheme(),
      priceUnit: this.getPriceUnitLabel(),
      thresholdPercent: this.getNumberSetting('price_threshold_percent', 25),
      minDiffOre: this.getNumberSetting('price_min_diff_ore', 0),
      now,
      timeZone,
    });
    const existingPayload = this.getSettingValue(COMBINED_PRICES);
    // Data safety: never replace still-valid prices with an empty rebuild. A
    // missing/transiently-unreadable/invalid raw flow slot makes the rebuild
    // empty; its fingerprint differs from the populated cache, so the set()
    // below would otherwise clobber good today/tomorrow prices on a transient
    // read (boot catch-up, midnight rotation, every caller). Keep the cache.
    if (combinedRebuildLostActionableEntries(existingPayload, payload, now, timeZone)) {
      this.debugStructured({ event: 'combined_prices_rebuild_lost_entries_kept_cache' });
      this.emitRealtime('prices_updated', existingPayload);
      return;
    }
    if (toCombinedPayloadFingerprint(existingPayload) === toCombinedPayloadFingerprint(payload)) {
      const nextLastFetched = getCombinedPayloadLastFetched(payload);
      const previousLastFetched = getCombinedPayloadLastFetched(existingPayload);
      const shouldUpdateLastFetched = Boolean(nextLastFetched && nextLastFetched !== previousLastFetched);
      this.debugStructured({ event: 'combined_prices_unchanged', lastFetchedUpdated: shouldUpdateLastFetched });
      if (shouldUpdateLastFetched) this.homey.settings.set(COMBINED_PRICES, payload);
      this.emitRealtime('prices_updated', payload);
      return;
    }
    this.homey.settings.set(COMBINED_PRICES, payload);
    this.emitRealtime('prices_updated', payload);
    this.onCombinedPricesUpdated?.('changed');
  }

  getCombinedHourlyPrices(): CombinedHourlyPrice[] {
    const scheme = this.getPriceScheme();
    if (scheme === 'flow') return this.getCombinedHourlyPricesFromFlow();
    if (scheme === 'homey') return this.getCombinedHourlyPricesFromHomey();
    return this.getCombinedHourlyPricesNorway();
  }

  private getCombinedHourlyPricesNorway(): CombinedHourlyPrice[] {
    const priceArea = this.getPriceArea();
    const gridTariffSettings = this.getGridTariffSettings();
    const norwayPriceModel = this.getNorwayPriceModel();
    const timeZone = this.homey.clock.getTimezone();
    const currentMonthKey = getDateKeyInTimeZone(new Date(), timeZone).slice(0, 7);
    return buildCombinedHourlyPricesNorway({
      spotPrices: this.getSettingValue('electricity_prices'),
      gridTariffData: this.getSettingValue('nettleie_data'),
      providerSurchargeIncVat: this.getNumberSetting('provider_surcharge', 0),
      priceArea,
      countyCode: gridTariffSettings.countyCode,
      tariffGroup: gridTariffSettings.tariffGroup,
      norwayPriceModel,
      monthUsageKwh: norwayPriceModel === 'norgespris' ? getCurrentMonthUsageKwh(this.homey) : 0,
      hourlyUsageEstimateKwh: norwayPriceModel === 'norgespris' ? getHourlyUsageEstimateKwh(this.homey) : 0,
      now: new Date(),
      currentMonthKey,
      timeZone,
    });
  }

  private rotateFlowPriceSlots(params: {
    now: Date;
    timeZone: string;
    todaySettingKey: string;
    tomorrowSettingKey: string;
    label: 'Flow prices' | 'Homey prices';
  }): { todayPayload: FlowPricePayload | null; tomorrowPayload: FlowPricePayload | null } {
    const { now, timeZone, todaySettingKey, tomorrowSettingKey, label } = params;
    const purge = purgeStaleFlowPriceSlots({
      now,
      timeZone,
      todayPayload: getFlowPricePayload(this.getSettingValue(todaySettingKey)),
      tomorrowPayload: getFlowPricePayload(this.getSettingValue(tomorrowSettingKey)),
    });
    purge.changes.forEach((change: FlowSlotChange) => {
      this.debugStructured({
        event: 'flow_price_slot_rotated', priceSource: label,
        slot: change.slot, action: change.action, from: change.from,
      });
    });
    if (purge.changes.some((c) => c.slot === 'today' || c.action === 'promoted_to_today')) {
      this.homey.settings.set(todaySettingKey, purge.todayPayload);
    }
    if (purge.changes.some((c) => c.slot === 'tomorrow')) {
      this.homey.settings.set(tomorrowSettingKey, purge.tomorrowPayload);
    }
    return { todayPayload: purge.todayPayload, tomorrowPayload: purge.tomorrowPayload };
  }

  private buildCombinedHourlyPricesWithRotation(params: {
    todaySettingKey: string;
    tomorrowSettingKey: string;
    label: 'Flow prices' | 'Homey prices';
  }): CombinedHourlyPrice[] {
    const { todaySettingKey, tomorrowSettingKey, label } = params;
    const now = new Date();
    const timeZone = this.homey.clock.getTimezone();
    const { todayPayload, tomorrowPayload } = this.rotateFlowPriceSlots({
      now,
      timeZone,
      todaySettingKey,
      tomorrowSettingKey,
      label,
    });
    return buildCombinedHourlyPricesFromPayloads({
      now,
      timeZone,
      todayPayload,
      tomorrowPayload,
      debugStructured: this.debugStructured,
      label,
    });
  }

  private getCombinedHourlyPricesFromFlow(): CombinedHourlyPrice[] {
    return this.buildCombinedHourlyPricesWithRotation({
      todaySettingKey: FLOW_PRICES_TODAY,
      tomorrowSettingKey: FLOW_PRICES_TOMORROW,
      label: 'Flow prices',
    });
  }

  private getCombinedHourlyPricesFromHomey(): CombinedHourlyPrice[] {
    return this.buildCombinedHourlyPricesWithRotation({
      todaySettingKey: HOMEY_PRICES_TODAY,
      tomorrowSettingKey: HOMEY_PRICES_TOMORROW,
      label: 'Homey prices',
    });
  }

  storeFlowPriceData(kind: 'today' | 'tomorrow', raw: unknown): {
    dateKey: string;
    storedCount: number;
    missingHours: number[];
  } {
    return storeFlowPriceDataHelper({
      kind,
      raw,
      timeZone: this.homey.clock.getTimezone(),
      debugStructured: this.debugStructured,
      setSetting: (key, value) => this.homey.settings.set(key, value),
      updateCombinedPrices: () => this.updateCombinedPrices(),
    });
  }

  findCheapestHours(count: number): string[] {
    const now = new Date();
    const in24Hours = new Date(now.getTime() + 24 * 60 * 60 * 1000);

    const prices = this.getCombinedHourlyPrices()
      .filter((p) => {
        const time = new Date(p.startsAt);
        return time >= now && time < in24Hours;
      });

    if (prices.length === 0) return [];

    return prices
      .sort((a, b) => a.totalPrice - b.totalPrice)
      .slice(0, count)
      .map((p) => p.startsAt);
  }

  isCurrentHourCheap(): boolean {
    return this.isCurrentHourAtLevel('cheap');
  }

  isCurrentHourExpensive(): boolean {
    return this.isCurrentHourAtLevel('expensive');
  }

  getCurrentHourPriceInfo(): string {
    const prices = this.getCombinedHourlyPrices();
    const current = getCurrentHourPrice(prices);
    if (!current) return 'price unknown';
    return this.getPriceScheme() === 'norway'
      ? formatNorwayPriceInfo(current)
      : formatFlowPriceInfo(current, this.getPriceUnitLabel());
  }

  private getPriceArea(): string {
    const priceAreaSetting = this.getSettingValue('price_area');
    return typeof priceAreaSetting === 'string' && priceAreaSetting ? priceAreaSetting : 'NO1';
  }

  private getGridTariffSettings(): { countyCode: string; organizationNumber: string | null; tariffGroup: string } {
    const countySetting = this.getSettingValue('nettleie_fylke');
    const countyCode = typeof countySetting === 'string' && countySetting ? countySetting : '03';
    const organizationSetting = this.getSettingValue('nettleie_orgnr');
    const organizationNumber = typeof organizationSetting === 'string' && organizationSetting
      ? organizationSetting
      : null;
    const tariffGroupSetting = this.getSettingValue('nettleie_tariffgruppe');
    const tariffGroup = typeof tariffGroupSetting === 'string' && tariffGroupSetting
      ? tariffGroupSetting
      : 'Husholdning';
    return { countyCode, organizationNumber, tariffGroup };
  }

  private getNorwayPriceModel(): 'stromstotte' | 'norgespris' {
    const raw = this.getSettingValue(NORWAY_PRICE_MODEL);
    return raw === 'norgespris' ? 'norgespris' : 'stromstotte';
  }

  private isCurrentHourAtLevel(level: 'cheap' | 'expensive'): boolean {
    return isCurrentHourAtLevel({
      prices: this.getCombinedHourlyPrices(),
      level,
      thresholdPercent: this.getNumberSetting('price_threshold_percent', 25),
      minDiff: this.getNumberSetting('price_min_diff_ore', 0),
    });
  }

  getCurrentHourStartMs(): number {
    const current = getCurrentHourPrice(this.getCombinedHourlyPrices());
    if (current) return new Date(current.startsAt).getTime();
    const timeZone = this.homey.clock.getTimezone();
    return getHourStartInTimeZone(new Date(), timeZone);
  }

  private async refreshHomeyEnergyPrices(forceRefresh: boolean): Promise<void> {
    if (this.getPriceScheme() !== 'homey') {
      this.debugStructured({ event: 'homey_energy_refresh_skipped', reason: 'non_homey_scheme' });
      return;
    }
    const energyApi = this.getHomeyEnergyApi?.();
    if (!energyApi) {
      this.log('Homey prices: Homey energy API not available');
      return;
    }
    const info = buildHomeyEnergyDateInfo(this.homey.clock.getTimezone());
    if (shouldUseHomeyEnergyCache({
      info,
      forceRefresh,
      getSettingValue: (key) => this.getSettingValue(key),
      debugStructured: this.debugStructured,
      updateCombinedPrices: () => this.updateCombinedPrices(),
    })) {
      return;
    }

    const results = await fetchHomeyEnergyResults({
      energyApi,
      info,
      log: this.log,
      errorLog: this.errorLog,
    });
    if (!results) return;

    logHomeyEnergyPayloadStatus({
      info,
      results,
      log: this.log,
      debugStructured: this.debugStructured,
      errorLog: this.errorLog,
    });

    await updateHomeyEnergyCurrency({
      energyApi,
      results,
      setSetting: (key, value) => this.homey.settings.set(key, value),
      debugStructured: this.debugStructured,
      errorLog: this.errorLog,
    });
    const stored = storeHomeyEnergyPayloads({
      results,
      setSetting: (key, value) => this.homey.settings.set(key, value),
    });
    if (stored === 0) {
      this.log('Homey prices: No price data available');
      return;
    }
    this.log(`Homey prices: Stored ${stored} day${stored === 1 ? '' : 's'} of price data`);
    this.updateCombinedPrices();
  }
}
