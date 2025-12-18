import Homey from 'homey';
import { httpsGetJson } from './httpClient';

export interface CombinedHourlyPrice {
  startsAt: string;
  spotPrice: number;
  nettleie: number;
  providerSurcharge: number;
  totalPrice: number;
}

export default class PriceService {
  constructor(
    private homey: Homey.App['homey'],
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- log accepts any
    private log: (...args: any[]) => void,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- log accepts any
    private logDebug: (...args: any[]) => void,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- log accepts any
    private errorLog?: (...args: any[]) => void,
  ) {}

  async refreshSpotPrices(forceRefresh = false): Promise<void> {
    const priceArea = this.homey.settings.get('price_area') || 'NO1';
    const cachedArea = this.homey.settings.get('electricity_prices_area');
    const today = new Date();
    const todayStr = today.toISOString().split('T')[0];
    const tomorrowStr = new Date(today.getTime() + 24 * 60 * 60 * 1000).toISOString().split('T')[0];

    if (!forceRefresh) {
      const existingPrices = this.homey.settings.get('electricity_prices') as Array<{ startsAt?: string }> | null;
      const areaChanged = cachedArea && cachedArea !== priceArea;
      if (areaChanged) {
        this.logDebug(`Spot prices: Price area changed from ${cachedArea} to ${priceArea}, ignoring cache`);
      }
      if (!areaChanged && existingPrices && Array.isArray(existingPrices) && existingPrices.length > 0) {
        const hasTodayPrices = existingPrices.some((p) => p.startsAt?.startsWith(todayStr));
        const hasTomorrowPrices = existingPrices.some((p) => p.startsAt?.startsWith(tomorrowStr));

        const currentHourUtc = today.getUTCHours();
        const currentMinuteUtc = today.getUTCMinutes();
        const isAfter1215Utc = currentHourUtc > 12 || (currentHourUtc === 12 && currentMinuteUtc >= 15);
        const shouldFetchTomorrow = isAfter1215Utc && !hasTomorrowPrices;

        if (hasTodayPrices && !shouldFetchTomorrow) {
          this.logDebug(`Spot prices: Using cached data (${existingPrices.length} entries including today)`);
          this.updateCombinedPrices();
          return;
        }

        if (shouldFetchTomorrow) {
          this.logDebug('Spot prices: Refreshing to fetch tomorrow\'s prices (after 12:15 UTC)');
        }
      }
    }

    const todayPrices = await this.fetchSpotPricesForDate(today, priceArea);

    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);
    const tomorrowPrices = await this.fetchSpotPricesForDate(tomorrow, priceArea);

    const allPrices = [...todayPrices, ...tomorrowPrices];

    if (allPrices.length > 0) {
      this.homey.settings.set('electricity_prices', allPrices);
      this.homey.settings.set('electricity_prices_area', priceArea);
      this.log(`Spot prices: Stored ${allPrices.length} hourly prices for ${priceArea}`);
      this.updateCombinedPrices();
    } else {
      this.log('Spot prices: No price data available');
    }
  }

  async refreshNettleieData(forceRefresh = false): Promise<void> {
    const fylke = this.homey.settings.get('nettleie_fylke') || '03';
    const orgnr = this.homey.settings.get('nettleie_orgnr');
    const tariffgruppe = this.homey.settings.get('nettleie_tariffgruppe') || 'Husholdning';

    if (!orgnr) {
      this.log('Nettleie: No organization number configured, skipping fetch');
      return;
    }

    const today = this.formatDateInHomeyTimezone(new Date());

    if (!forceRefresh) {
      const existingData = this.homey.settings.get('nettleie_data') as Array<{ datoId?: string }> | null;
      if (existingData && Array.isArray(existingData) && existingData.length > 0) {
        const firstEntry = existingData[0];
        if (firstEntry?.datoId?.startsWith(today)) {
          this.logDebug(`Nettleie: Using cached data for ${today} (${existingData.length} entries)`);
          this.updateCombinedPrices();
          return;
        }
      }
    }

    const baseUrl = 'https://nettleietariffer.dataplattform.nve.no/v1/NettleiePerOmradePrTimeHusholdningFritidEffekttariffer';
    const params = new URLSearchParams({
      ValgtDato: today,
      Tariffgruppe: tariffgruppe,
      FylkeNr: fylke,
      OrganisasjonsNr: orgnr,
    });
    const url = `${baseUrl}?${params.toString()}`;

    this.log(`Nettleie: Fetching grid tariffs from NVE API for ${today}, fylke=${fylke}, org=${orgnr}`);

    try {
      const response = await fetch(url, {
        headers: {
          Accept: 'application/json',
        },
      });

      if (!response.ok) {
        throw new Error(`NVE API returned ${response.status}: ${response.statusText}`);
      }

      const data = await response.json();

      if (!Array.isArray(data)) {
        this.errorLog?.('Nettleie: Unexpected response format from NVE API');
        return;
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- NVE API response type
      const nettleieData = data.map((entry: Record<string, unknown>) => ({
        time: entry.time,
        energileddEks: entry.energileddEks,
        energileddInk: entry.energileddInk,
        fastleddEks: entry.fastleddEks,
        fastleddInk: entry.fastleddInk,
        datoId: entry.datoId,
      }));

      this.homey.settings.set('nettleie_data', nettleieData);
      this.log(`Nettleie: Stored ${nettleieData.length} hourly tariff entries`);
      this.updateCombinedPrices();
    } catch (error) {
      this.errorLog?.('Nettleie: Failed to fetch grid tariffs from NVE API', error);
    }
  }

  updateCombinedPrices(): void {
    const combined = this.getCombinedHourlyPrices();
    if (combined.length === 0) {
      const emptyPrices = {
        prices: [], avgPrice: 0, lowThreshold: 0, highThreshold: 0,
      };
      this.homey.settings.set('combined_prices', emptyPrices);
      this.homey.api.realtime('prices_updated', emptyPrices).catch(() => {});
      return;
    }

    const avgPrice = combined.reduce((sum, p) => sum + p.totalPrice, 0) / combined.length;
    const thresholdPercent = this.homey.settings.get('price_threshold_percent') ?? 25;
    const minDiffOre = this.homey.settings.get('price_min_diff_ore') ?? 0;
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
    this.homey.api.realtime('prices_updated', combinedPrices).catch(() => {});
  }

  getCombinedHourlyPrices(): CombinedHourlyPrice[] {
    const spotPrices: Array<{ startsAt: string; total: number }> = this.homey.settings.get('electricity_prices') || [];
    const nettleieData: Array<{ time: string; energileddInk: number }> = this.homey.settings.get('nettleie_data') || [];
    const providerSurcharge: number = this.homey.settings.get('provider_surcharge') || 0;

    const nettleieByHour = new Map<number, number>();
    for (const entry of nettleieData) {
      const hour = typeof entry.time === 'number' ? entry.time : parseInt(entry.time, 10);
      if (!Number.isNaN(hour) && typeof entry.energileddInk === 'number') {
        nettleieByHour.set(hour, entry.energileddInk);
      }
    }

    return spotPrices.map((spot) => {
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
    const prices = this.getCombinedHourlyPrices();
    if (prices.length === 0) return false;

    const now = new Date();
    const currentHourStart = new Date(now);
    currentHourStart.setMinutes(0, 0, 0);

    const currentPrice = prices.find((p) => {
      const hourStart = new Date(p.startsAt);
      return hourStart.getTime() === currentHourStart.getTime();
    });

    if (!currentPrice) return false;

    const avgPrice = prices.reduce((sum, p) => sum + p.totalPrice, 0) / prices.length;
    const thresholdPercent = this.homey.settings.get('price_threshold_percent') ?? 25;
    const minDiffOre = this.homey.settings.get('price_min_diff_ore') ?? 0;
    const threshold = avgPrice * (1 - thresholdPercent / 100);
    const diffFromAvg = avgPrice - currentPrice.totalPrice;
    return currentPrice.totalPrice <= threshold && diffFromAvg >= minDiffOre;
  }

  isCurrentHourExpensive(): boolean {
    const prices = this.getCombinedHourlyPrices();
    if (prices.length === 0) return false;

    const now = new Date();
    const currentHourStart = new Date(now);
    currentHourStart.setMinutes(0, 0, 0);

    const currentPrice = prices.find((p) => {
      const hourStart = new Date(p.startsAt);
      return hourStart.getTime() === currentHourStart.getTime();
    });

    if (!currentPrice) return false;

    const avgPrice = prices.reduce((sum, p) => sum + p.totalPrice, 0) / prices.length;
    const thresholdPercent = this.homey.settings.get('price_threshold_percent') ?? 25;
    const minDiffOre = this.homey.settings.get('price_min_diff_ore') ?? 0;
    const threshold = avgPrice * (1 + thresholdPercent / 100);
    const diffFromAvg = currentPrice.totalPrice - avgPrice;
    return currentPrice.totalPrice >= threshold && diffFromAvg >= minDiffOre;
  }

  getCurrentHourPriceInfo(): string {
    const prices = this.getCombinedHourlyPrices();
    const now = new Date();
    const currentHourStart = new Date(now);
    currentHourStart.setMinutes(0, 0, 0);

    const current = prices.find((p) => {
      const hourStart = new Date(p.startsAt);
      return hourStart.getTime() === currentHourStart.getTime();
    });

    if (!current) return 'price unknown';
    return `${current.totalPrice.toFixed(1)} øre/kWh (spot ${current.spotPrice.toFixed(1)} + nettleie ${current.nettleie.toFixed(1)})`;
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
}
