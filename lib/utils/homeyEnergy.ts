export type HomeyEnergyPriceInterval = {
  periodStart: string;
  periodEnd?: string;
  value: number;
};

export type HomeyEnergyPriceDocument = {
  zoneId?: string;
  zoneName?: string;
  zoneVersion?: string;
  zoneCountryKey?: string;
  priceIntervals?: string[];
  defaultPriceInterval?: string;
  priceInterval?: string;
  periodStart?: string;
  periodEnd?: string;
  priceUnit?: string;
  measureUnit?: string;
  interval?: number;
  pricesPerInterval?: HomeyEnergyPriceInterval[];
  highestPriceWithUserCosts?: number;
  lowestPriceWithUserCosts?: number;
  averagePriceWithUserCosts?: number;
};

export type HomeyEnergyPricesResponse = HomeyEnergyPriceDocument | HomeyEnergyPriceDocument[];

/**
 * Homey Energy's day-ahead prices. The body is untrusted until
 * `normalizeHomeyEnergyPrices` has read it, so the port promises nothing about
 * its shape.
 */

import { isUnknownRecord } from '../../packages/shared-domain/src/recordGuards';
export type HomeyEnergyApi = {
  fetchDynamicElectricityPrices: (opts: { date: string }) => Promise<unknown>;
};

/** A Web API rejection carries a status code and the body as its message. */
export const formatHomeyEnergyError = (error: unknown): { message: string; statusCode?: number } => {
  const message = error instanceof Error ? error.message : String(error);
  if (!isUnknownRecord(error) || typeof error.statusCode !== 'number') return { message };
  return { message, statusCode: error.statusCode };
};
