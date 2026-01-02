import Homey from 'homey';
import { formatDateInTimeZone, getHourStartInTimeZone } from './priceTime';
import {
  COMBINED_PRICES,
  FLOW_PRICES_TODAY,
  FLOW_PRICES_TOMORROW,
  HOMEY_PRICES_CURRENCY,
  HOMEY_PRICES_TODAY,
  HOMEY_PRICES_TOMORROW,
  PRICE_SCHEME,
} from '../utils/settingsKeys';
import {
  addDays,
  buildGridTariffFallbackDates,
  getSpotPriceCacheDecision,
  getSpotPriceDates,
} from './priceServiceUtils';
import { getFlowPricePayload } from './flowPriceUtils';
import {
  fetchAndNormalizeGridTariff,
  shouldUseGridTariffCache,
} from './gridTariffUtils';
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
  storeFlowPriceData as storeFlowPriceDataHelper,
} from './priceServiceFlowHelpers';
import { buildCombinedPricePayload } from './priceServiceCombined';
import { buildCombinedHourlyPricesNorway } from './priceServiceNorway';
import { fetchSpotPricesForDate } from './spotPriceFetch';
import { getCurrentHourPrice, isCurrentHourAtLevel } from './priceLevelUtils';
import type { CombinedHourlyPrice, PriceScheme } from './priceTypes';
import type { HomeyEnergyApi } from '../utils/homeyEnergy';

export default class PriceService {
  constructor(
    private homey: Homey.App['homey'],
    private log: (...args: unknown[]) => void,
    private logDebug: (...args: unknown[]) => void,
    private errorLog?: (...args: unknown[]) => void,
    private getHomeyEnergyApi?: () => HomeyEnergyApi | null,
  ) { }
  private getSettingValue(key: string): unknown {
    return this.homey.settings.get(key) as unknown;
  }
  private getNumberSetting(key: string, fallback: number): number {
    const value = this.getSettingValue(key);
    return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
  }
  private emitRealtime(event: string, payload: unknown): void {
    const api = (this.homey as { api?: { realtime?: (evt: string, data: unknown) => Promise<void> } }).api;
    if (!api?.realtime) return;
    api.realtime(event, payload).catch((err) => this.errorLog?.('Failed to emit realtime event', event, err));
  }

  private getPriceScheme(): PriceScheme {
    const raw = this.getSettingValue(PRICE_SCHEME);
    if (raw === 'flow' || raw === 'homey') return raw;
    return 'norway';
  }

  private getPriceUnitLabel(): string {
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
      this.logDebug(`Spot prices: Price area changed from ${cachedArea} to ${priceArea}, ignoring cache`);
    }
    if (cacheDecision.useCache) {
      this.logDebug(`Spot prices: Using cached data (${existingPrices?.length ?? 0} entries including today)`);
      this.updateCombinedPrices();
      return true;
    }
    if (cacheDecision.shouldFetchTomorrow) {
      this.logDebug('Spot prices: Refreshing to fetch tomorrow\'s prices (after 12:15 UTC)');
    }
    return false;
  }
  async refreshSpotPrices(forceRefresh = false): Promise<void> {
    const scheme = this.getPriceScheme();
    if (scheme === 'flow') {
      this.logDebug('Spot prices: Skipping refresh (flow price scheme active)');
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
      logDebug: this.logDebug,
      errorLog: this.errorLog,
    });
    const tomorrowPrices = await fetchSpotPricesForDate({
      date: addDays(today, 1),
      priceArea,
      log: this.log,
      logDebug: this.logDebug,
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
      this.logDebug('Grid tariff: Skipping refresh (non-Norway price scheme active)');
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
    const today = formatDateInTimeZone(todayDate, timeZone);
    const existingData = this.getSettingValue('nettleie_data') as Array<{ dateKey?: string; datoId?: string }> | null;
    if (!forceRefresh && shouldUseGridTariffCache(existingData, today, this.logDebug)) {
      this.updateCombinedPrices();
      return;
    }

    const attempts: Array<{ label: string; date: string }> = [{ label: 'today', date: today }];
    const normalized = await fetchAndNormalizeGridTariff({
      date: today,
      settings: requestSettings,
      log: this.log,
      errorLog: this.errorLog,
    });
    if (normalized) {
      this.storeGridTariffData(normalized, '');
      return;
    }

    for (const fallback of buildGridTariffFallbackDates(todayDate)) {
      const fallbackDate = formatDateInTimeZone(fallback.date, timeZone);
      if (attempts.some((attempt) => attempt.date === fallbackDate)) {
        continue;
      }
      attempts.push({ label: fallback.label, date: fallbackDate });
      const fallbackData = await fetchAndNormalizeGridTariff({
        date: fallbackDate,
        settings: requestSettings,
        log: this.log,
        errorLog: this.errorLog,
      });
      if (fallbackData) {
        this.storeGridTariffData(fallbackData, ` (fallback ${fallback.label} ${fallbackDate})`);
        return;
      }
    }

    this.errorLog?.('Grid tariff: Keeping cached tariff data (NVE returned empty list)', {
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
    const combined = this.getCombinedHourlyPrices();
    const payload = buildCombinedPricePayload({
      combined,
      priceScheme: this.getPriceScheme(),
      priceUnit: this.getPriceUnitLabel(),
      thresholdPercent: this.getNumberSetting('price_threshold_percent', 25),
      minDiffOre: this.getNumberSetting('price_min_diff_ore', 0),
      now: new Date(),
    });
    this.homey.settings.set(COMBINED_PRICES, payload);
    this.emitRealtime('prices_updated', payload);
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
    return buildCombinedHourlyPricesNorway({
      spotPrices: this.getSettingValue('electricity_prices'),
      gridTariffData: this.getSettingValue('nettleie_data'),
      providerSurchargeIncVat: this.getNumberSetting('provider_surcharge', 0),
      priceArea,
      countyCode: gridTariffSettings.countyCode,
    });
  }

  private getCombinedHourlyPricesFromFlow(): CombinedHourlyPrice[] {
    return buildCombinedHourlyPricesFromPayloads({
      now: new Date(),
      timeZone: this.homey.clock.getTimezone(),
      todayPayload: getFlowPricePayload(this.getSettingValue(FLOW_PRICES_TODAY)),
      tomorrowPayload: getFlowPricePayload(this.getSettingValue(FLOW_PRICES_TOMORROW)),
      logDebug: this.logDebug,
      label: 'Flow prices',
      allowTomorrowAsToday: true,
    });
  }

  private getCombinedHourlyPricesFromHomey(): CombinedHourlyPrice[] {
    return buildCombinedHourlyPricesFromPayloads({
      now: new Date(),
      timeZone: this.homey.clock.getTimezone(),
      todayPayload: getFlowPricePayload(this.getSettingValue(HOMEY_PRICES_TODAY)),
      tomorrowPayload: getFlowPricePayload(this.getSettingValue(HOMEY_PRICES_TOMORROW)),
      logDebug: this.logDebug,
      label: 'Homey prices',
      allowTomorrowAsToday: false,
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
      logDebug: this.logDebug,
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
      ? this.formatNorwayPriceInfo(current)
      : this.formatFlowPriceInfo(current);
  }

  private formatFlowPriceInfo(current: CombinedHourlyPrice): string {
    return `${current.totalPrice.toFixed(4)} ${this.getPriceUnitLabel()} (as provided)`;
  }

  private formatNorwayPriceInfo(current: CombinedHourlyPrice): string {
    const format = (value: number | undefined) => (value ?? 0).toFixed(1);
    return `${current.totalPrice.toFixed(1)} øre/kWh (spot price ${format(current.spotPriceExVat)} ex VAT`
      + ` + grid tariff ${format(current.gridTariffExVat)}`
      + ` + surcharge ${format(current.providerSurchargeExVat)}`
      + ` + consumption tax ${format(current.consumptionTaxExVat)}`
      + ` + Enova fee ${format(current.enovaFeeExVat)}`
      + ` + VAT ${format(current.vatAmount)}`
      + ` - electricity support ${format(current.electricitySupport)})`;
  }

  private getPriceArea(): string {
    const priceAreaSetting = this.getSettingValue('price_area');
    return typeof priceAreaSetting === 'string' && priceAreaSetting ? priceAreaSetting : 'NO1';
  }

  private getGridTariffSettings(): { countyCode: string; organizationNumber: string | null; tariffGroup: string } {
    const countySetting = this.getSettingValue('nettleie_fylke');
    const countyCode = typeof countySetting === 'string' && countySetting ? countySetting : '03';
    const organizationSetting = this.getSettingValue('nettleie_orgnr');
    const organizationNumber = typeof organizationSetting === 'string' && organizationSetting ? organizationSetting : null;
    const tariffGroupSetting = this.getSettingValue('nettleie_tariffgruppe');
    const tariffGroup = typeof tariffGroupSetting === 'string' && tariffGroupSetting
      ? tariffGroupSetting
      : 'Husholdning';
    return { countyCode, organizationNumber, tariffGroup };
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
      this.logDebug('Homey prices: Skipping refresh (price scheme not homey)');
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
      logDebug: this.logDebug,
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
      logDebug: this.logDebug,
      errorLog: this.errorLog,
    });

    await updateHomeyEnergyCurrency({
      energyApi,
      results,
      setSetting: (key, value) => this.homey.settings.set(key, value),
      logDebug: this.logDebug,
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
