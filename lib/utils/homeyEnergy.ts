import Homey from 'homey';

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

export type HomeyEnergyCurrencyResponse = string | {
  currency?: string;
  code?: string;
  unit?: string;
  label?: string;
  name?: string;
};

export type HomeyEnergyApi = {
  fetchDynamicElectricityPrices: (opts: { date: string }) => Promise<HomeyEnergyPricesResponse>;
  getCurrency?: () => Promise<HomeyEnergyCurrencyResponse>;
  // ManagerEnergy API (HomeyAPIV3Local.ManagerEnergy.getLiveReport).
  // Optional because it may not be exposed/available in every runtime path (SDK vs HomeyAPI).
  getLiveReport?: (opts: { zone?: string }) => Promise<unknown>;
};

type RecordLike = Record<string, unknown>;

const isRecord = (value: unknown): value is RecordLike => (
  typeof value === 'object' && value !== null
);

const hasFunction = (value: unknown, key: string): value is RecordLike => (
  isRecord(value) && typeof value[key] === 'function'
);

export const isHomeyEnergyApi = (value: unknown): value is HomeyEnergyApi => (
  hasFunction(value, 'fetchDynamicElectricityPrices')
);

export const resolveHomeyEnergyApiFromSdk = (homey: Homey.App['homey']): HomeyEnergyApi | null => {
  const apiContainer = (homey as { api?: unknown }).api;
  if (!isRecord(apiContainer)) return null;
  const energyApi = apiContainer.energy;
  return isHomeyEnergyApi(energyApi) ? energyApi : null;
};

export const resolveHomeyEnergyApiFromHomeyApi = (client: unknown): HomeyEnergyApi | null => {
  if (!isRecord(client)) return null;
  const energyApi = client.energy;
  return isHomeyEnergyApi(energyApi) ? energyApi : null;
};

export const resolveCurrencyLabel = (value: unknown): string | null => {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed ? trimmed : null;
  }
  if (!isRecord(value)) return null;
  const candidates = [
    value.currency,
    value.code,
    value.unit,
    value.label,
    value.name,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === 'string') {
      const trimmed = candidate.trim();
      if (trimmed) return trimmed;
    }
  }
  return null;
};

export const formatHomeyEnergyError = (error: unknown): {
  message: string;
  statusCode?: number;
  description?: string;
  code?: string;
} => {
  const baseMessage = error instanceof Error ? error.message : String(error);
  if (!isRecord(error)) {
    return { message: baseMessage };
  }
  const statusCode = typeof error.statusCode === 'number' ? error.statusCode : undefined;
  const description = typeof error.description === 'string' && error.description ? error.description : undefined;
  const code = typeof error.code === 'string' && error.code ? error.code : undefined;
  return {
    message: baseMessage,
    ...(typeof statusCode === 'number' ? { statusCode } : {}),
    ...(description ? { description } : {}),
    ...(code ? { code } : {}),
  };
};
