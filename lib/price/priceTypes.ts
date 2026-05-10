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
  norgesprisAdjustmentExVat?: number;
  norgesprisAdjustment?: number;
  totalExVat?: number;
};

export type PriceScheme = 'norway' | 'flow' | 'homey';

export type CombinedPriceEntry = {
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
  norgesprisAdjustmentExVat?: number;
  norgesprisAdjustment?: number;
  totalExVat?: number;
  isCheap: boolean;
  isExpensive: boolean;
};

export type CombinedPriceDayEntries = {
  hours: CombinedPriceEntry[];
};

export const COMBINED_PRICES_VERSION = 2 as const;

export type CombinedPricesV2 = {
  version: typeof COMBINED_PRICES_VERSION;
  days: Record<string, CombinedPriceDayEntries>;
  avgPrice: number;
  lowThreshold: number;
  highThreshold: number;
  priceScheme: PriceScheme;
  priceUnit: string;
  thresholdPercent?: number;
  minDiffOre?: number;
  lastFetched?: string;
};

const isFiniteNumber = (value: unknown): value is number => (
  typeof value === 'number' && Number.isFinite(value)
);

const isHourEntry = (value: unknown): boolean => {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return typeof record.startsAt === 'string'
    && isFiniteNumber(record.total)
    && typeof record.isCheap === 'boolean'
    && typeof record.isExpensive === 'boolean';
};

const isDayEntry = (value: unknown): boolean => {
  if (!value || typeof value !== 'object') return false;
  const hours = (value as { hours?: unknown }).hours;
  return Array.isArray(hours) && hours.every(isHourEntry);
};

export const isCombinedPricesV2 = (value: unknown): value is CombinedPricesV2 => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (record.version !== COMBINED_PRICES_VERSION) return false;
  if (!isFiniteNumber(record.avgPrice)) return false;
  if (!isFiniteNumber(record.lowThreshold) || !isFiniteNumber(record.highThreshold)) return false;
  if (typeof record.priceScheme !== 'string' || typeof record.priceUnit !== 'string') return false;
  if (!record.days || typeof record.days !== 'object' || Array.isArray(record.days)) return false;
  return Object.values(record.days as Record<string, unknown>).every(isDayEntry);
};
