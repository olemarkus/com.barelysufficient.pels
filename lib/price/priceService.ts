import Homey from 'homey';
import { fetchSpotPricesForDate } from './priceFetcher';
import { calculateNorwegianTaxes, getVatMultiplier } from './norwegianTaxes';
import { getDateKeyInTimeZone, getHourStartInTimeZone } from '../utils/dateUtils';

export type CombinedHourlyPrice = {
  startsAt: string;
  spotPrice: number;
  gridRent: number;
  providerSurcharge: number;
  consumptionTax: number;
  enovaFee: number;
  subsidy: number;
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
    const dates = this.getSpotPriceDates(today);

    if (!forceRefresh) {
      const existingPrices = this.getSettingValue('electricity_prices') as Array<{ startsAt?: string }> | null;
      const cacheDecision = this.getSpotPriceCacheDecision({
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

    const todayPrices = await fetchSpotPricesForDate(today, priceArea, {
      log: this.log,
      debug: this.logDebug,
      error: this.errorLog,
    });
    const tomorrowPrices = await fetchSpotPricesForDate(this.addDays(today, 1), priceArea, {
      log: this.log,
      debug: this.logDebug,
      error: this.errorLog,
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

  async refreshNettleieData(forceRefresh = false): Promise<void> {
    const settings = this.getNettleieSettings();
    if (!settings.orgnr) {
      this.log('Grid tariff: No organization number configured, skipping fetch');
      return;
    }
    const requestSettings: { fylke: string; orgnr: string; tariffgruppe: string } = {
      fylke: settings.fylke,
      orgnr: settings.orgnr,
      tariffgruppe: settings.tariffgruppe,
    };

    const todayDate = new Date();
    const today = getDateKeyInTimeZone(todayDate, this.homey.clock.getTimezone());
    if (!forceRefresh && this.shouldUseNettleieCache(today)) {
      return;
    }

    const attempts: Array<{ label: string; date: string }> = [{ label: 'today', date: today }];
    const normalized = await this.fetchAndNormalizeNettleie({ date: today, settings: requestSettings });
    if (normalized) {
      this.storeNettleieData(normalized, '');
      return;
    }

    for (const fallback of this.buildNettleieFallbackDates(todayDate)) {
      const fallbackDate = getDateKeyInTimeZone(fallback.date, this.homey.clock.getTimezone());
      if (attempts.some((attempt) => attempt.date === fallbackDate)) {
        continue;
      }
      attempts.push({ label: fallback.label, date: fallbackDate });
      const fallbackData = await this.fetchAndNormalizeNettleie({ date: fallbackDate, settings: requestSettings });
      if (fallbackData) {
        this.storeNettleieData(fallbackData, ` (fallback ${fallback.label} ${fallbackDate})`);
        return;
      }
    }

    this.errorLog?.('Grid tariff: Keeping cached tariff data (NVE returned empty list)', {
      attempts,
      fylke: requestSettings.fylke,
      orgnr: requestSettings.orgnr,
      tariffgruppe: requestSettings.tariffgruppe,
    });
  }

  private buildNettleieFallbackDates(baseDate: Date): Array<{ label: string; date: Date }> {
    const yesterday = new Date(baseDate);
    yesterday.setDate(yesterday.getDate() - 1);

    const weekAgo = new Date(baseDate);
    weekAgo.setDate(weekAgo.getDate() - 7);

    const monthAgo = this.subtractMonths(baseDate, 1);

    return [
      { label: 'yesterday', date: yesterday },
      { label: 'week', date: weekAgo },
      { label: 'month', date: monthAgo },
    ];
  }

  private subtractMonths(date: Date, months: number): Date {
    const target = new Date(date);
    const day = target.getDate();
    target.setDate(1);
    target.setMonth(target.getMonth() - months);
    const daysInMonth = new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate();
    target.setDate(Math.min(day, daysInMonth));
    return target;
  }

  private storeNettleieData(data: Array<Record<string, unknown>>, logContext: string): void {
    this.homey.settings.set('nettleie_data', data);
    this.log(`Grid tariff: Stored ${data.length} hourly tariff entries${logContext}`);
    this.updateCombinedPrices();
  }

  private async fetchAndNormalizeNettleie(params: {
    date: string;
    settings: { fylke: string; orgnr: string; tariffgruppe: string };
  }): Promise<Array<Record<string, unknown>> | null> {
    const { date, settings } = params;
    const url = this.buildNettleieUrl({
      date,
      fylke: settings.fylke,
      orgnr: settings.orgnr,
      tariffgruppe: settings.tariffgruppe,
    });
    this.log(`Grid tariff: Fetching NVE tariffs for ${date}, county=${settings.fylke}, org=${settings.orgnr}`);
    const nettleieData = await this.fetchNettleieData(url);
    if (!nettleieData) return null;
    const normalized = this.normalizeNettleieData(nettleieData);
    if (normalized.length === 0) {
      this.errorLog?.(
        'Grid tariff: NVE API returned 0 hourly tariff entries',
        { date, fylke: settings.fylke, orgnr: settings.orgnr, tariffgruppe: settings.tariffgruppe },
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
        spotPrice: p.spotPrice,
        gridRent: p.gridRent,
        providerSurcharge: p.providerSurcharge,
        consumptionTax: p.consumptionTax,
        enovaFee: p.enovaFee,
        subsidy: p.subsidy,
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
    const nettleieData = this.getSettingValue('nettleie_data');
    const providerSurcharge = this.getNumberSetting('provider_surcharge', 0);
    const priceArea = this.getPriceArea();
    const spotList = Array.isArray(spotPrices)
      ? spotPrices as Array<{ startsAt: string; total: number; totalExVat?: number }> // 'total' includes VAT
      : [];
    const nettleieList = Array.isArray(nettleieData) ? nettleieData as Array<{ time: string; energyFeeIncVat: number }> : [];

    const nettleieByHour = new Map<number, number>();
    for (const entry of nettleieList) {
      const hour = typeof entry.time === 'number' ? entry.time : parseInt(entry.time, 10);
      if (!Number.isNaN(hour) && typeof entry.energyFeeIncVat === 'number') {
        nettleieByHour.set(hour, entry.energyFeeIncVat);
      }
    }

    return spotList.map((spot) => {
      const date = new Date(spot.startsAt);
      const hour = date.getHours();
      const gridRent = nettleieByHour.get(hour) || 0;

      // Calculate spot price ex. VAT for subsidy calculation
      const vatMultiplier = getVatMultiplier(priceArea);
      const spotPriceExVat = spot.totalExVat ?? spot.total / vatMultiplier;

      const taxes = calculateNorwegianTaxes({
        spotPriceExVat,
        priceArea,
      });

      // Total = spot (inc VAT) + gridRent + surcharge + taxes - subsidy
      const totalPrice = spot.total + gridRent + providerSurcharge
        + taxes.consumptionTax + taxes.enovaFee - taxes.subsidy;

      return {
        startsAt: spot.startsAt,
        spotPrice: spot.total,
        gridRent,
        providerSurcharge,
        consumptionTax: taxes.consumptionTax,
        enovaFee: taxes.enovaFee,
        subsidy: taxes.subsidy,
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

    let breakdown = `spot ${current.spotPrice.toFixed(1)} + grid rent ${current.gridRent.toFixed(1)}`;
    if (current.consumptionTax > 0) {
      breakdown += ` + tax ${current.consumptionTax.toFixed(1)}`;
    }
    if (current.subsidy > 0) {
      breakdown += ` - subsidy ${current.subsidy.toFixed(1)}`;
    }
    return `${current.totalPrice.toFixed(1)} øre/kWh (${breakdown})`;
  }

  private getPriceArea(): string {
    const priceAreaSetting = this.getSettingValue('price_area');
    return typeof priceAreaSetting === 'string' && priceAreaSetting ? priceAreaSetting : 'NO1';
  }

  private addDays(date: Date, days: number): Date {
    const next = new Date(date);
    next.setDate(next.getDate() + days);
    return next;
  }

  private getSpotPriceDates(today: Date): { todayStr: string; tomorrowStr: string } {
    const todayStr = today.toISOString().split('T')[0];
    const tomorrowStr = this.addDays(today, 1).toISOString().split('T')[0];
    return { todayStr, tomorrowStr };
  }

  private getSpotPriceCacheDecision(params: {
    cachedArea: unknown;
    priceArea: string;
    existingPrices: Array<{ startsAt?: string }> | null;
    dates: { todayStr: string; tomorrowStr: string };
    now: Date;
  }): { useCache: boolean; shouldFetchTomorrow: boolean; areaChanged: boolean } {
    const { cachedArea, priceArea, existingPrices, dates, now } = params;
    const areaChanged = typeof cachedArea === 'string' && cachedArea !== priceArea;
    if (!existingPrices || !Array.isArray(existingPrices) || existingPrices.length === 0 || areaChanged) {
      return { useCache: false, shouldFetchTomorrow: false, areaChanged };
    }

    const hasTodayPrices = existingPrices.some((p) => p.startsAt?.startsWith(dates.todayStr));
    const hasTomorrowPrices = existingPrices.some((p) => p.startsAt?.startsWith(dates.tomorrowStr));
    const shouldFetchTomorrow = this.shouldFetchTomorrowPrices(now, hasTomorrowPrices);
    const useCache = hasTodayPrices && !shouldFetchTomorrow;
    return { useCache, shouldFetchTomorrow, areaChanged };
  }

  private shouldFetchTomorrowPrices(now: Date, hasTomorrowPrices: boolean): boolean {
    const currentHourUtc = now.getUTCHours();
    const currentMinuteUtc = now.getUTCMinutes();
    const isAfter1215Utc = currentHourUtc > 12 || (currentHourUtc === 12 && currentMinuteUtc >= 15);
    return isAfter1215Utc && !hasTomorrowPrices;
  }

  private getNettleieSettings(): { fylke: string; orgnr: string | null; tariffgruppe: string } {
    const fylkeSetting = this.getSettingValue('nettleie_fylke');
    const fylke = typeof fylkeSetting === 'string' && fylkeSetting ? fylkeSetting : '03';
    const orgnrSetting = this.getSettingValue('nettleie_orgnr');
    const orgnr = typeof orgnrSetting === 'string' && orgnrSetting ? orgnrSetting : null;
    const tariffgruppeSetting = this.getSettingValue('nettleie_tariffgruppe');
    const tariffgruppe = typeof tariffgruppeSetting === 'string' && tariffgruppeSetting
      ? tariffgruppeSetting
      : 'Husholdning';
    return { fylke, orgnr, tariffgruppe };
  }

  private shouldUseNettleieCache(today: string): boolean {
    const existingData = this.getSettingValue('nettleie_data') as Array<{ dateId?: string }> | null;
    if (existingData && Array.isArray(existingData) && existingData.length > 0) {
      const firstEntry = existingData[0];
      if (firstEntry?.dateId?.startsWith(today)) {
        this.logDebug(`Grid tariff: Using cached data for ${today} (${existingData.length} entries)`);
        this.updateCombinedPrices();
        return true;
      }
    }
    return false;
  }

  private buildNettleieUrl(params: {
    date: string;
    tariffgruppe: string;
    fylke: string;
    orgnr: string;
  }): string {
    const baseUrl = 'https://nettleietariffer.dataplattform.nve.no/v1/NettleiePerOmradePrTimeHusholdningFritidEffekttariffer';
    const search = new URLSearchParams({
      ValgtDato: params.date,
      Tariffgruppe: params.tariffgruppe,
      FylkeNr: params.fylke,
      OrganisasjonsNr: params.orgnr,
    });
    return `${baseUrl}?${search.toString()}`;
  }

  private async fetchNettleieData(url: string): Promise<Array<Record<string, unknown>> | null> {
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

  private normalizeNettleieData(data: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
    return data.map((entry) => ({
      time: entry.time,
      energyFeeExVat: entry.energileddEks,
      energyFeeIncVat: entry.energileddInk,
      fixedFeeExVat: entry.fastleddEks,
      fixedFeeIncVat: entry.fastleddInk,
      dateId: entry.datoId,
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



  getCurrentHourStartMs(): number {
    const current = this.getCurrentHourPrice(this.getCombinedHourlyPrices());
    if (current) return new Date(current.startsAt).getTime();
    return getHourStartInTimeZone(new Date(), this.homey.clock.getTimezone());
  }
}
