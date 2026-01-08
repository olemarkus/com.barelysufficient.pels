import { httpsGetJson } from '../utils/httpClient';
import { getVatMultiplier } from './norwegianTaxes';

export type PriceLogger = {
    log: (...args: unknown[]) => void;
    debug: (...args: unknown[]) => void;
    error?: (...args: unknown[]) => void;
};

export async function fetchSpotPricesForDate(
    date: Date,
    priceArea: string,
    logger: PriceLogger,
): Promise<Array<{ startsAt: string; total: number; totalExVat: number; currency: string }>> {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');

    const url = `https://www.hvakosterstrommen.no/api/v1/prices/${year}/${month}-${day}_${priceArea}.json`;

    logger.debug(`Spot prices: Fetching from ${url}`);

    try {
        const data = await httpsGetJson(url, { log: logger.log });

        if (!Array.isArray(data)) {
            logger.error?.('Spot prices: Unexpected response format');
            return [];
        }

        const vatMultiplier = getVatMultiplier(priceArea);
        const rawPriceOre = (entry: Record<string, unknown>) => (entry.NOK_per_kWh as number) * 100;

        return data.map((entry: Record<string, unknown>) => {
            const totalExVat = rawPriceOre(entry);
            return {
                startsAt: entry.time_start as string,
                total: totalExVat * vatMultiplier,
                totalExVat,
                currency: 'NOK',
            };
        });
    } catch (error: unknown) {
        if ((error as { statusCode?: number })?.statusCode === 404) {
            logger.debug(`Spot prices: No data for ${year}-${month}-${day} (not yet available)`);
            return [];
        }
        logger.error?.(`Spot prices: Failed to fetch prices for ${year}-${month}-${day}`, error);
        return [];
    }
}
