import type { CombinedHourlyPrice, PriceScheme } from './priceTypes';

type CombinedPriceEntry = {
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
  totalExVat?: number;
  isCheap: boolean;
  isExpensive: boolean;
};

type CombinedPricePayload = {
  prices: CombinedPriceEntry[];
  avgPrice: number;
  lowThreshold: number;
  highThreshold: number;
  priceScheme: PriceScheme;
  priceUnit: string;
  thresholdPercent?: number;
  minDiffOre?: number;
  lastFetched?: string;
};

export const buildCombinedPricePayload = (params: {
  combined: CombinedHourlyPrice[];
  priceScheme: PriceScheme;
  priceUnit: string;
  thresholdPercent: number;
  minDiffOre: number;
  now: Date;
}): CombinedPricePayload => {
  const {
    combined,
    priceScheme,
    priceUnit,
    thresholdPercent,
    minDiffOre,
    now,
  } = params;
  if (combined.length === 0) {
    return {
      prices: [],
      avgPrice: 0,
      lowThreshold: 0,
      highThreshold: 0,
      priceScheme,
      priceUnit,
    };
  }

  const avgPrice = combined.reduce((sum, p) => sum + p.totalPrice, 0) / combined.length;
  const thresholdMultiplier = thresholdPercent / 100;
  const lowThreshold = avgPrice * (1 - thresholdMultiplier);
  const highThreshold = avgPrice * (1 + thresholdMultiplier);
  const hasNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

  const prices = combined.map((p) => {
    const diffFromAvg = Math.abs(p.totalPrice - avgPrice);
    const meetsMinDiff = diffFromAvg >= minDiffOre;
    const baseEntry: CombinedPriceEntry = {
      startsAt: p.startsAt,
      total: p.totalPrice,
      isCheap: p.totalPrice <= lowThreshold && meetsMinDiff,
      isExpensive: p.totalPrice >= highThreshold && meetsMinDiff,
    };
    const extra: Partial<CombinedPriceEntry> = {
      ...(hasNumber(p.spotPriceExVat) ? { spotPriceExVat: p.spotPriceExVat } : {}),
      ...(hasNumber(p.gridTariffExVat) ? { gridTariffExVat: p.gridTariffExVat } : {}),
      ...(hasNumber(p.providerSurchargeExVat) ? { providerSurchargeExVat: p.providerSurchargeExVat } : {}),
      ...(hasNumber(p.consumptionTaxExVat) ? { consumptionTaxExVat: p.consumptionTaxExVat } : {}),
      ...(hasNumber(p.enovaFeeExVat) ? { enovaFeeExVat: p.enovaFeeExVat } : {}),
      ...(hasNumber(p.vatMultiplier) ? { vatMultiplier: p.vatMultiplier } : {}),
      ...(hasNumber(p.vatAmount) ? { vatAmount: p.vatAmount } : {}),
      ...(hasNumber(p.electricitySupportExVat) ? { electricitySupportExVat: p.electricitySupportExVat } : {}),
      ...(hasNumber(p.electricitySupport) ? { electricitySupport: p.electricitySupport } : {}),
      ...(hasNumber(p.totalExVat) ? { totalExVat: p.totalExVat } : {}),
    };
    return { ...baseEntry, ...extra };
  });

  return {
    prices,
    avgPrice,
    lowThreshold,
    highThreshold,
    thresholdPercent,
    minDiffOre,
    lastFetched: now.toISOString(),
    priceScheme,
    priceUnit,
  };
};
