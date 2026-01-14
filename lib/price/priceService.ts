import Homey from 'homey';
import {
  calculateElectricitySupport,
  getRegionalPricingRules,
} from './priceComponents';
import { formatDateInTimeZone, getHourStartInTimeZone } from './priceTime';
import { getDateKeyInTimeZone } from '../utils/dateUtils';
import { FLOW_PRICES_TODAY, FLOW_PRICES_TOMORROW, PRICE_SCHEME } from '../utils/settingsKeys';
import {
  addDays,
  buildGridTariffFallbackDates,
  getSpotPriceCacheDecision,
  getSpotPriceDates,
} from './priceServiceUtils';
import {
  buildFlowEntries,
  getFlowPricePayload,
  getMissingFlowHours,
  parseFlowPriceInput,
  type FlowPricePayload,
} from './flowPriceUtils';
import {
  fetchAndNormalizeGridTariff,
  shouldUseGridTariffCache,
} from './gridTariffUtils';
import { fetchSpotPricesForDate } from './spotPriceFetch';
import { getCurrentHourPrice, isCurrentHourAtLevel } from './priceLevelUtils';

export type CombinedHourlyPrice = {
  startsAt: string;
  totalPrice: number;
  spotPriceExVat?: number;
  gridTariffExVat?: number;
  providerSurchargeExVat?: number;
  consumptionTaxExVat?: number;
  enovaFeeExVat?: number;
  vatMultiplier?: number;
  vatAmount?: number;
  electricitySupportExVat?: number;
  electricitySupport?: number;
  totalExVat?: number;
};

export type PriceScheme = 'norway' | 'flow';

export default class PriceService {
  constructor(
    private homey: Homey.App['homey'],
    private log: (...args: unknown[]) => void,
    private logDebug: (...args: unknown[]) => void,
    private errorLog?: (...args: unknown[]) => void,
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
    return raw === 'flow' ? 'flow' : 'norway';
  }

  private getPriceUnitLabel(): string {
    return this.getPriceScheme() === 'flow' ? 'price units' : 'øre/kWh';
  }
  async refreshSpotPrices(forceRefresh = false): Promise<void> {
    if (this.getPriceScheme() === 'flow') {
      this.logDebug('Spot prices: Skipping refresh (flow price scheme active)');
      return;
    }
    const priceArea = this.getPriceArea();
    const cachedArea = this.getSettingValue('electricity_prices_area');
    const today = new Date();
    const dates = getSpotPriceDates(today);

    if (!forceRefresh) {
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
        return;
      }
      if (cacheDecision.shouldFetchTomorrow) {
        this.logDebug('Spot prices: Refreshing to fetch tomorrow\'s prices (after 12:15 UTC)');
      }
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
    if (this.getPriceScheme() === 'flow') {
      this.logDebug('Grid tariff: Skipping refresh (flow price scheme active)');
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
    const priceScheme = this.getPriceScheme();
    const priceUnit = this.getPriceUnitLabel();
    if (combined.length === 0) {
      const emptyPrices = {
        prices: [], avgPrice: 0, lowThreshold: 0, highThreshold: 0,
        priceScheme,
        priceUnit,
      };
      this.homey.settings.set('combined_prices', emptyPrices);
      this.emitRealtime('prices_updated', emptyPrices);
      return;
    }

    const avgPrice = combined.reduce((sum, p) => sum + p.totalPrice, 0) / combined.length;
    const thresholdPercent = this.getNumberSetting('price_threshold_percent', 25);
    const minDiffOre = this.getNumberSetting('price_min_diff_ore', 0);
    const thresholdMultiplier = thresholdPercent / 100;
    const lowThreshold = avgPrice * (1 - thresholdMultiplier);
    const highThreshold = avgPrice * (1 + thresholdMultiplier);
    const hasNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

    const prices = combined.map((p) => {
      const diffFromAvg = Math.abs(p.totalPrice - avgPrice);
      const meetsMinDiff = diffFromAvg >= minDiffOre;
      const entry: {
        startsAt: string;
        total: number;
        spotPriceExVat?: number;
        gridTariffExVat?: number;
        providerSurchargeExVat?: number;
        consumptionTaxExVat?: number;
        enovaFeeExVat?: number;
        vatMultiplier?: number;
        vatAmount?: number;
        electricitySupportExVat?: number;
        electricitySupport?: number;
        totalExVat?: number;
        isCheap: boolean;
        isExpensive: boolean;
      } = {
        startsAt: p.startsAt,
        total: p.totalPrice,
        isCheap: p.totalPrice <= lowThreshold && meetsMinDiff,
        isExpensive: p.totalPrice >= highThreshold && meetsMinDiff,
      };
      if (hasNumber(p.spotPriceExVat)) entry.spotPriceExVat = p.spotPriceExVat;
      if (hasNumber(p.gridTariffExVat)) entry.gridTariffExVat = p.gridTariffExVat;
      if (hasNumber(p.providerSurchargeExVat)) entry.providerSurchargeExVat = p.providerSurchargeExVat;
      if (hasNumber(p.consumptionTaxExVat)) entry.consumptionTaxExVat = p.consumptionTaxExVat;
      if (hasNumber(p.enovaFeeExVat)) entry.enovaFeeExVat = p.enovaFeeExVat;
      if (hasNumber(p.vatMultiplier)) entry.vatMultiplier = p.vatMultiplier;
      if (hasNumber(p.vatAmount)) entry.vatAmount = p.vatAmount;
      if (hasNumber(p.electricitySupportExVat)) entry.electricitySupportExVat = p.electricitySupportExVat;
      if (hasNumber(p.electricitySupport)) entry.electricitySupport = p.electricitySupport;
      if (hasNumber(p.totalExVat)) entry.totalExVat = p.totalExVat;
      return entry;
    });

    const combinedPrices = {
      prices,
      avgPrice,
      lowThreshold,
      highThreshold,
      thresholdPercent,
      minDiffOre,
      lastFetched: new Date().toISOString(),
      priceScheme,
      priceUnit,
    };
    this.homey.settings.set('combined_prices', combinedPrices);
    this.emitRealtime('prices_updated', combinedPrices);
  }

  getCombinedHourlyPrices(): CombinedHourlyPrice[] {
    if (this.getPriceScheme() === 'flow') {
      return this.getCombinedHourlyPricesFromFlow();
    }
    return this.getCombinedHourlyPricesNorway();
  }

  private getCombinedHourlyPricesNorway(): CombinedHourlyPrice[] {
    const spotPrices = this.getSettingValue('electricity_prices');
    const gridTariffData = this.getSettingValue('nettleie_data');
    const providerSurchargeIncVat = this.getNumberSetting('provider_surcharge', 0);
    const spotList = Array.isArray(spotPrices)
      ? spotPrices as Array<{ startsAt: string; total?: number; spotPriceExVat?: number; totalExVat?: number }>
      : [];
    const gridTariffList = Array.isArray(gridTariffData)
      ? gridTariffData as Array<{
        time?: number | string;
        energyFeeExVat?: number | null;
        energyFeeIncVat?: number | null;
        energileddEks?: number | null;
        energileddInk?: number | null;
      }>
      : [];

    const priceArea = this.getPriceArea();
    const gridTariffSettings = this.getGridTariffSettings();
    const rules = getRegionalPricingRules(priceArea, gridTariffSettings.countyCode);
    const providerSurchargeExVat = providerSurchargeIncVat / rules.vatMultiplier;

    const getNumber = (value: unknown): number | null => (
      typeof value === 'number' && Number.isFinite(value) ? value : null
    );

    const gridTariffByHour = new Map<number, number>();
    for (const entry of gridTariffList) {
      const hourValue = typeof entry.time === 'number' ? entry.time : parseInt(String(entry.time ?? ''), 10);
      if (Number.isNaN(hourValue)) continue;
      const energyFeeExVat = getNumber(entry.energyFeeExVat ?? entry.energileddEks);
      const energyFeeIncVat = getNumber(entry.energyFeeIncVat ?? entry.energileddInk);
      const resolvedExVat = energyFeeExVat ?? (energyFeeIncVat !== null ? energyFeeIncVat / rules.vatMultiplier : null);
      if (resolvedExVat !== null) {
        gridTariffByHour.set(hourValue, resolvedExVat);
      }
    }

    const resolveSpotPriceExVat = (entry: { total?: number; spotPriceExVat?: number; totalExVat?: number }): number => {
      const exVat = getNumber(entry.spotPriceExVat ?? entry.totalExVat);
      if (exVat !== null) return exVat;
      const total = getNumber(entry.total);
      return total !== null ? total / rules.vatMultiplier : 0;
    };

    return spotList.map((spot) => {
      const date = new Date(spot.startsAt);
      const hour = date.getHours();
      const spotPriceExVat = resolveSpotPriceExVat(spot);
      const gridTariffExVat = gridTariffByHour.get(hour) || 0;
      const consumptionTaxExVat = rules.consumptionTaxExVat;
      const enovaFeeExVat = rules.enovaFeeExVat;
      const totalExVat = spotPriceExVat + gridTariffExVat + providerSurchargeExVat + consumptionTaxExVat + enovaFeeExVat;
      const electricitySupportExVat = calculateElectricitySupport(
        spotPriceExVat,
        rules.supportThresholdExVat,
        rules.supportCoverage,
      );
      const vatAmount = totalExVat * (rules.vatMultiplier - 1);
      const electricitySupport = electricitySupportExVat * rules.vatMultiplier;
      const totalPrice = totalExVat * rules.vatMultiplier - electricitySupport;
      return {
        startsAt: spot.startsAt,
        spotPriceExVat,
        gridTariffExVat,
        providerSurchargeExVat,
        consumptionTaxExVat,
        enovaFeeExVat,
        vatMultiplier: rules.vatMultiplier,
        vatAmount,
        electricitySupportExVat,
        electricitySupport,
        totalExVat,
        totalPrice,
      };
    }).sort((a, b) => new Date(a.startsAt).getTime() - new Date(b.startsAt).getTime());
  }

  private getCombinedHourlyPricesFromFlow(): CombinedHourlyPrice[] {
    const timeZone = this.homey.clock.getTimezone();
    const todayKey = getDateKeyInTimeZone(new Date(), timeZone);
    const tomorrowKey = getDateKeyInTimeZone(addDays(new Date(), 1), timeZone);

    const todayPayload = getFlowPricePayload(this.getSettingValue(FLOW_PRICES_TODAY));
    const tomorrowPayload = getFlowPricePayload(this.getSettingValue(FLOW_PRICES_TOMORROW));

    const entries: CombinedHourlyPrice[] = [];

    const usePayload = (payload: FlowPricePayload | null, key: string, label: 'today' | 'tomorrow'): boolean => {
      if (payload?.dateKey !== key) {
        if (payload) {
          this.logDebug(`Flow prices: Ignoring stored ${label} data for ${payload.dateKey} (expected ${key})`);
        }
        return false;
      }
      entries.push(...buildFlowEntries(payload, timeZone));
      return true;
    };

    const usedToday = usePayload(todayPayload, todayKey, 'today');
    const usedTomorrowAsToday = !usedToday && tomorrowPayload?.dateKey === todayKey;
    if (usedTomorrowAsToday && tomorrowPayload) {
      this.logDebug(`Flow prices: Using stored tomorrow data for ${todayKey} as today`);
      entries.push(...buildFlowEntries(tomorrowPayload, timeZone));
    }

    if (!usedTomorrowAsToday) {
      usePayload(tomorrowPayload, tomorrowKey, 'tomorrow');
    }

    return entries.sort((a, b) => new Date(a.startsAt).getTime() - new Date(b.startsAt).getTime());
  }

  storeFlowPriceData(kind: 'today' | 'tomorrow', raw: unknown): {
    dateKey: string;
    storedCount: number;
    missingHours: number[];
  } {
    const pricesByHour = parseFlowPriceInput(raw);
    const timeZone = this.homey.clock.getTimezone();
    const baseDate = kind === 'tomorrow' ? addDays(new Date(), 1) : new Date();
    const dateKey = getDateKeyInTimeZone(baseDate, timeZone);

    const payload: FlowPricePayload = {
      dateKey,
      pricesByHour,
      updatedAt: new Date().toISOString(),
    };

    const settingKey = kind === 'today' ? FLOW_PRICES_TODAY : FLOW_PRICES_TOMORROW;
    this.homey.settings.set(settingKey, payload);

    const missingHours = getMissingFlowHours(pricesByHour);
    if (missingHours.length > 0) {
      this.logDebug(`Flow prices: Missing ${missingHours.length} hour(s) for ${dateKey}`, missingHours);
    }

    this.updateCombinedPrices();

    return {
      dateKey,
      storedCount: Object.keys(pricesByHour).length,
      missingHours,
    };
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
    return this.getPriceScheme() === 'flow'
      ? this.formatFlowPriceInfo(current)
      : this.formatNorwayPriceInfo(current);
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
}
