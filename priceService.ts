import Homey from 'homey';
import { httpsGetJson } from './httpClient';

export type CombinedHourlyPrice = {
  startsAt: string;
  spotPrice: number;
  nettleie: number;
  providerSurcharge: number;
  totalPrice: number;
};

export default class PriceService {
  constructor(
    private homey: Homey.App['homey'],
    private log: (...args: unknown[]) => void,
    private logDebug: (...args: unknown[]) => void,
    private errorLog?: (...args: unknown[]) => void,
  ) {}

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
    api.realtime(event, payload).catch(() => {});
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

    const todayPrices = await this.fetchSpotPricesForDate(today, priceArea);
    const tomorrowPrices = await this.fetchSpotPricesForDate(this.addDays(today, 1), priceArea);
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
      this.log('Nettleie: No organization number configured, skipping fetch');
      return;
    }

    const today = this.formatDateInHomeyTimezone(new Date());
    if (!forceRefresh && this.shouldUseNettleieCache(today)) {
      return;
    }

    const url = this.buildNettleieUrl({
      date: today,
      fylke: settings.fylke,
      orgnr: settings.orgnr,
      tariffgruppe: settings.tariffgruppe,
    });
    this.log(`Nettleie: Fetching grid tariffs from NVE API for ${today}, fylke=${settings.fylke}, org=${settings.orgnr}`);
    const nettleieData = await this.fetchNettleieData(url);
    if (!nettleieData) return;
    const normalized = this.normalizeNettleieData(nettleieData);
    this.homey.settings.set('nettleie_data', normalized);
    this.log(`Nettleie: Stored ${normalized.length} hourly tariff entries`);
    this.updateCombinedPrices();
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
        nettleie: p.nettleie,
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
    const spotList = Array.isArray(spotPrices) ? spotPrices as Array<{ startsAt: string; total: number }> : [];
    const nettleieList = Array.isArray(nettleieData) ? nettleieData as Array<{ time: string; energileddInk: number }> : [];

    const nettleieByHour = new Map<number, number>();
    for (const entry of nettleieList) {
      const hour = typeof entry.time === 'number' ? entry.time : parseInt(entry.time, 10);
      if (!Number.isNaN(hour) && typeof entry.energileddInk === 'number') {
        nettleieByHour.set(hour, entry.energileddInk);
      }
    }

    return spotList.map((spot) => {
      const date = new Date(spot.startsAt);
      const hour = date.getHours();
      const nettleie = nettleieByHour.get(hour) || 0;
      return {
        startsAt: spot.startsAt,
        spotPrice: spot.total,
        nettleie,
        providerSurcharge,
        totalPrice: spot.total + nettleie + providerSurcharge,
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
    return `${current.totalPrice.toFixed(1)} øre/kWh (spot ${current.spotPrice.toFixed(1)} + nettleie ${current.nettleie.toFixed(1)})`;
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
    const existingData = this.getSettingValue('nettleie_data') as Array<{ datoId?: string }> | null;
    if (existingData && Array.isArray(existingData) && existingData.length > 0) {
      const firstEntry = existingData[0];
      if (firstEntry?.datoId?.startsWith(today)) {
        this.logDebug(`Nettleie: Using cached data for ${today} (${existingData.length} entries)`);
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
        this.errorLog?.('Nettleie: Unexpected response format from NVE API');
        return null;
      }
      return data as Array<Record<string, unknown>>;
    } catch (error) {
      this.errorLog?.('Nettleie: Failed to fetch grid tariffs from NVE API', error);
      return null;
    }
  }

  private normalizeNettleieData(data: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
    return data.map((entry) => ({
      time: entry.time,
      energileddEks: entry.energileddEks,
      energileddInk: entry.energileddInk,
      fastleddEks: entry.fastleddEks,
      fastleddInk: entry.fastleddInk,
      datoId: entry.datoId,
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

  private async fetchSpotPricesForDate(date: Date, priceArea: string): Promise<Array<{ startsAt: string; total: number; currency: string }>> {
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

      const vatMultiplier = priceArea === 'NO4' ? 1.0 : 1.25;

      return data.map((entry: Record<string, unknown>) => ({
        startsAt: entry.time_start as string,
        total: (entry.NOK_per_kWh as number) * 100 * vatMultiplier,
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

  private formatDateInHomeyTimezone(date: Date): string {
    const timezone = this.homey.clock.getTimezone();
    try {
      const formatter = new Intl.DateTimeFormat('sv-SE', {
        timeZone: timezone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      });
      return formatter.format(date);
    } catch {
      const year = date.getFullYear();
      const month = String(date.getMonth() + 1).padStart(2, '0');
      const day = String(date.getDate()).padStart(2, '0');
      return `${year}-${month}-${day}`;
    }
  }

  getCurrentHourStartMs(): number {
    const current = this.getCurrentHourPrice(this.getCombinedHourlyPrices());
    if (current) return new Date(current.startsAt).getTime();
    return this.getHourStartInHomeyTimezone(new Date());
  }

  private getHourStartInHomeyTimezone(date: Date): number {
    const timezone = this.homey.clock.getTimezone();
    try {
      const formatter = new Intl.DateTimeFormat('sv-SE', {
        timeZone: timezone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false,
      });
      const parts = formatter.formatToParts(date);
      const getPart = (type: Intl.DateTimeFormatPartTypes) => {
        const part = parts.find((entry) => entry.type === type);
        return part ? part.value : '';
      };
      const year = Number(getPart('year'));
      const month = Number(getPart('month'));
      const day = Number(getPart('day'));
      const hour = Number(getPart('hour'));
      const minute = Number(getPart('minute'));
      const second = Number(getPart('second'));
      if ([year, month, day, hour, minute, second].some((value) => !Number.isFinite(value))) {
        throw new Error('Invalid date parts');
      }
      const utcCandidate = Date.UTC(year, month - 1, day, hour, minute, second);
      const offsetMs = utcCandidate - date.getTime();
      return Date.UTC(year, month - 1, day, hour, 0, 0, 0) - offsetMs;
    } catch {
      const fallback = new Date(date);
      fallback.setMinutes(0, 0, 0);
      return fallback.getTime();
    }
  }
}
