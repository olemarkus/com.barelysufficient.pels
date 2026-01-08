import Homey from 'homey';
import { httpsGetJson } from '../utils/httpClient';
import {
  calculateElectricitySupport,
  getRegionalPricingRules,
} from './priceComponents';
import { formatDateInTimeZone, getHourStartInTimeZone } from './priceTime';
import {
  addDays,
  buildGridTariffFallbackDates,
  getSpotPriceCacheDecision,
  getSpotPriceDates,
} from './priceServiceUtils';

export type CombinedHourlyPrice = {
  startsAt: string;
  spotPriceExVat: number;
  gridTariffExVat: number;
  providerSurchargeExVat: number;
  consumptionTaxExVat: number;
  enovaFeeExVat: number;
  vatMultiplier: number;
  vatAmount: number;
  electricitySupportExVat: number;
  electricitySupport: number;
  totalExVat: number;
  totalPrice: number;
};

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
  async refreshSpotPrices(forceRefresh = false): Promise<void> {
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

    const todayPrices = await this.fetchSpotPricesForDate(today, priceArea);
    const tomorrowPrices = await this.fetchSpotPricesForDate(addDays(today, 1), priceArea);
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
    if (!forceRefresh && this.shouldUseGridTariffCache(today)) {
      return;
    }

    const attempts: Array<{ label: string; date: string }> = [{ label: 'today', date: today }];
    const normalized = await this.fetchAndNormalizeGridTariff({ date: today, settings: requestSettings });
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
      const fallbackData = await this.fetchAndNormalizeGridTariff({ date: fallbackDate, settings: requestSettings });
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

  private async fetchAndNormalizeGridTariff(params: {
    date: string;
    settings: { countyCode: string; organizationNumber: string; tariffGroup: string };
  }): Promise<Array<Record<string, unknown>> | null> {
    const { date, settings } = params;
    const url = this.buildGridTariffUrl({
      date,
      countyCode: settings.countyCode,
      organizationNumber: settings.organizationNumber,
      tariffGroup: settings.tariffGroup,
    });
    this.log(`Grid tariff: Fetching NVE tariffs for ${date}, county=${settings.countyCode}, org=${settings.organizationNumber}`);
    const gridTariffData = await this.fetchGridTariffData(url);
    if (!gridTariffData) return null;
    const normalized = this.normalizeGridTariffData(gridTariffData);
    if (normalized.length === 0) {
      this.errorLog?.(
        'Grid tariff: NVE API returned 0 hourly tariff entries',
        {
          date,
          countyCode: settings.countyCode,
          organizationNumber: settings.organizationNumber,
          tariffGroup: settings.tariffGroup,
        },
      );
      return null;
    }
    return normalized;
  }

  updateCombinedPrices(): void {
    const combined = this.getCombinedHourlyPrices();
    if (combined.length === 0) {
      const emptyPrices = {
        prices: [], avgPrice: 0, lowThreshold: 0, highThreshold: 0,
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

    const prices = combined.map((p) => {
      const diffFromAvg = Math.abs(p.totalPrice - avgPrice);
      const meetsMinDiff = diffFromAvg >= minDiffOre;
      return {
        startsAt: p.startsAt,
        total: p.totalPrice,
        spotPriceExVat: p.spotPriceExVat,
        gridTariffExVat: p.gridTariffExVat,
        providerSurchargeExVat: p.providerSurchargeExVat,
        consumptionTaxExVat: p.consumptionTaxExVat,
        enovaFeeExVat: p.enovaFeeExVat,
        vatMultiplier: p.vatMultiplier,
        vatAmount: p.vatAmount,
        electricitySupportExVat: p.electricitySupportExVat,
        electricitySupport: p.electricitySupport,
        totalExVat: p.totalExVat,
        isCheap: p.totalPrice <= lowThreshold && meetsMinDiff,
        isExpensive: p.totalPrice >= highThreshold && meetsMinDiff,
      };
    });

    const combinedPrices = {
      prices,
      avgPrice,
      lowThreshold,
      highThreshold,
      thresholdPercent,
      minDiffOre,
      lastFetched: new Date().toISOString(),
    };
    this.homey.settings.set('combined_prices', combinedPrices);
    this.emitRealtime('prices_updated', combinedPrices);
  }

  getCombinedHourlyPrices(): CombinedHourlyPrice[] {
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
    const current = this.getCurrentHourPrice(prices);
    if (!current) return 'price unknown';
    return `${current.totalPrice.toFixed(1)} øre/kWh (spot price ${current.spotPriceExVat.toFixed(1)} ex VAT`
      + ` + grid tariff ${current.gridTariffExVat.toFixed(1)}`
      + ` + surcharge ${current.providerSurchargeExVat.toFixed(1)}`
      + ` + consumption tax ${current.consumptionTaxExVat.toFixed(1)}`
      + ` + Enova fee ${current.enovaFeeExVat.toFixed(1)}`
      + ` + VAT ${current.vatAmount.toFixed(1)}`
      + ` - electricity support ${current.electricitySupport.toFixed(1)})`;
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

  private shouldUseGridTariffCache(today: string): boolean {
    const existingData = this.getSettingValue('nettleie_data') as Array<{ dateKey?: string; datoId?: string }> | null;
    if (existingData && Array.isArray(existingData) && existingData.length > 0) {
      const firstEntry = existingData[0];
      const dateKey = typeof firstEntry?.dateKey === 'string' ? firstEntry.dateKey : firstEntry?.datoId;
      if (dateKey?.startsWith(today)) {
        this.logDebug(`Grid tariff: Using cached data for ${today} (${existingData.length} entries)`);
        this.updateCombinedPrices();
        return true;
      }
    }
    return false;
  }

  private buildGridTariffUrl(params: {
    date: string;
    tariffGroup: string;
    countyCode: string;
    organizationNumber: string;
  }): string {
    const baseUrl = 'https://nettleietariffer.dataplattform.nve.no/v1/NettleiePerOmradePrTimeHusholdningFritidEffekttariffer';
    const search = new URLSearchParams({
      ValgtDato: params.date,
      Tariffgruppe: params.tariffGroup,
      FylkeNr: params.countyCode,
      OrganisasjonsNr: params.organizationNumber,
    });
    return `${baseUrl}?${search.toString()}`;
  }

  private async fetchGridTariffData(url: string): Promise<Array<Record<string, unknown>> | null> {
    try {
      const response = await fetch(url, {
        headers: {
          Accept: 'application/json',
        },
      });
      if (!response.ok) {
        throw new Error(`NVE API returned ${response.status}: ${response.statusText}`);
      }
      const data = await response.json() as unknown;
      if (!Array.isArray(data)) {
        this.errorLog?.('Grid tariff: Unexpected response format from NVE API');
        return null;
      }
      return data as Array<Record<string, unknown>>;
    } catch (error) {
      this.errorLog?.('Grid tariff: Failed to fetch NVE tariffs', error);
      return null;
    }
  }

  private normalizeGridTariffData(data: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
    return data.map((entry) => ({
      time: entry.time,
      energyFeeExVat: entry.energileddEks,
      energyFeeIncVat: entry.energileddInk,
      fixedFeeExVat: entry.fastleddEks,
      fixedFeeIncVat: entry.fastleddInk,
      dateKey: entry.datoId,
    }));
  }

  private getCurrentHourPrice(prices: CombinedHourlyPrice[]): CombinedHourlyPrice | null {
    if (prices.length === 0) return null;
    const nowMs = Date.now();
    return prices.find((p) => {
      const hourStart = new Date(p.startsAt).getTime();
      return nowMs >= hourStart && nowMs < hourStart + 60 * 60 * 1000;
    }) || null;
  }

  private getAveragePrice(prices: CombinedHourlyPrice[]): number {
    return prices.reduce((sum, p) => sum + p.totalPrice, 0) / prices.length;
  }

  private getThresholds(avgPrice: number): { low: number; high: number; minDiff: number } {
    const thresholdPercent = this.getNumberSetting('price_threshold_percent', 25);
    const minDiffOre = this.getNumberSetting('price_min_diff_ore', 0);
    const thresholdMultiplier = thresholdPercent / 100;
    return {
      low: avgPrice * (1 - thresholdMultiplier),
      high: avgPrice * (1 + thresholdMultiplier),
      minDiff: minDiffOre,
    };
  }

  private isCurrentHourAtLevel(level: 'cheap' | 'expensive'): boolean {
    const prices = this.getCombinedHourlyPrices();
    const currentPrice = this.getCurrentHourPrice(prices);
    if (!currentPrice) return false;
    const avgPrice = this.getAveragePrice(prices);
    const thresholds = this.getThresholds(avgPrice);
    if (level === 'cheap') {
      const diffFromAvg = avgPrice - currentPrice.totalPrice;
      return currentPrice.totalPrice <= thresholds.low && diffFromAvg >= thresholds.minDiff;
    }
    const diffFromAvg = currentPrice.totalPrice - avgPrice;
    return currentPrice.totalPrice >= thresholds.high && diffFromAvg >= thresholds.minDiff;
  }

  private async fetchSpotPricesForDate(
    date: Date,
    priceArea: string,
  ): Promise<Array<{ startsAt: string; spotPriceExVat: number; currency: string }>> {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');

    const url = `https://www.hvakosterstrommen.no/api/v1/prices/${year}/${month}-${day}_${priceArea}.json`;

    this.logDebug(`Spot prices: Fetching from ${url}`);

    try {
      const data = await httpsGetJson(url, { log: this.log });

      if (!Array.isArray(data)) {
        this.errorLog?.('Spot prices: Unexpected response format');
        return [];
      }

      return data.map((entry: Record<string, unknown>) => ({
        startsAt: entry.time_start as string,
        spotPriceExVat: (entry.NOK_per_kWh as number) * 100,
        currency: 'NOK',
      }));
    } catch (error: unknown) {
      if ((error as { statusCode?: number })?.statusCode === 404) {
        this.logDebug(`Spot prices: No data for ${year}-${month}-${day} (not yet available)`);
        return [];
      }
      this.errorLog?.(`Spot prices: Failed to fetch prices for ${year}-${month}-${day}`, error);
      return [];
    }
  }

  getCurrentHourStartMs(): number {
    const current = this.getCurrentHourPrice(this.getCombinedHourlyPrices());
    if (current) return new Date(current.startsAt).getTime();
    const timeZone = this.homey.clock.getTimezone();
    return getHourStartInTimeZone(new Date(), timeZone);
  }
}
