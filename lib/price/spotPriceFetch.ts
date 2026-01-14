import { httpsGetJson } from '../utils/httpClient';

export type SpotPriceEntry = {
  startsAt: string;
  spotPriceExVat: number;
  currency: string;
};

export const fetchSpotPricesForDate = async (params: {
  date: Date;
  priceArea: string;
  log: (...args: unknown[]) => void;
  logDebug: (...args: unknown[]) => void;
  errorLog?: (...args: unknown[]) => void;
}): Promise<SpotPriceEntry[]> => {
  const { date, priceArea, log, logDebug, errorLog } = params;
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');

  const url = `https://www.hvakosterstrommen.no/api/v1/prices/${year}/${month}-${day}_${priceArea}.json`;

  logDebug(`Spot prices: Fetching from ${url}`);

  try {
    const data = await httpsGetJson(url, { log });

    if (!Array.isArray(data)) {
      errorLog?.('Spot prices: Unexpected response format');
      return [];
    }

    return data.map((entry: Record<string, unknown>) => ({
      startsAt: entry.time_start as string,
      spotPriceExVat: (entry.NOK_per_kWh as number) * 100,
      currency: 'NOK',
    }));
  } catch (error: unknown) {
    if ((error as { statusCode?: number })?.statusCode === 404) {
      logDebug(`Spot prices: No data for ${year}-${month}-${day} (not yet available)`);
      return [];
    }
    errorLog?.(`Spot prices: Failed to fetch prices for ${year}-${month}-${day}`, error);
    return [];
  }
};
