import { getDebugEmitter } from '../logging/logger';
import { httpsGetJson } from '../utils/httpClient';

const emitPriceDebug = getDebugEmitter('price', 'price');

export type SpotPriceEntry = {
  startsAt: string;
  spotPriceExVat: number;
  currency: string;
};

export const fetchSpotPricesForDate = async (params: {
  date: Date;
  priceArea: string;
  errorLog?: (...args: unknown[]) => void;
}): Promise<SpotPriceEntry[]> => {
  const { date, priceArea, errorLog } = params;
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');

  const url = `https://www.hvakosterstrommen.no/api/v1/prices/${year}/${month}-${day}_${priceArea}.json`;

  emitPriceDebug({ event: 'spot_price_fetch_started', url, priceArea });

  try {
    const data = await httpsGetJson(url);

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
      emitPriceDebug({ event: 'spot_price_fetch_no_data', date: `${year}-${month}-${day}` });
      return [];
    }
    errorLog?.(`Spot prices: Failed to fetch prices for ${year}-${month}-${day}`, error);
    return [];
  }
};
