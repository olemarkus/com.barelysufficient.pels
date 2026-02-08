import type { CombinedHourlyPrice, PriceScheme } from './priceTypes';
import { calculateAveragePrice, calculateThresholds, getPriceLevelFlags } from './priceMath';

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
  norgesprisAdjustmentExVat?: number;
  norgesprisAdjustment?: number;
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

  const avgPrice = calculateAveragePrice(combined, (entry) => entry.totalPrice);
  const { low: lowThreshold, high: highThreshold } = calculateThresholds(avgPrice, thresholdPercent);
  const hasNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

  const thresholds = { low: lowThreshold, high: highThreshold };

  const prices = combined.map((p) => {
    const flags = getPriceLevelFlags({
      price: p.totalPrice,
      avgPrice,
      thresholds,
      minDiff: minDiffOre,
    });
    const baseEntry: CombinedPriceEntry = {
      startsAt: p.startsAt,
      total: p.totalPrice,
      isCheap: flags.isCheap,
      isExpensive: flags.isExpensive,
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
      ...(hasNumber(p.norgesprisAdjustmentExVat) ? { norgesprisAdjustmentExVat: p.norgesprisAdjustmentExVat } : {}),
      ...(hasNumber(p.norgesprisAdjustment) ? { norgesprisAdjustment: p.norgesprisAdjustment } : {}),
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
