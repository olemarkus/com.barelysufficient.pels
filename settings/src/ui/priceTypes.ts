export type PriceEntry = {
  startsAt: string;
  total: number;
  spotPriceExVat?: number;
  gridTariffExVat?: number;
  providerSurchargeExVat?: number;
  consumptionTaxExVat?: number;
  enovaFeeExVat?: number;
  vatAmount?: number;
  vatMultiplier?: number;
  electricitySupportExVat?: number;
  electricitySupport?: number;
  norgesprisAdjustmentExVat?: number;
  norgesprisAdjustment?: number;
  totalExVat?: number;
  isCheap?: boolean;
  isExpensive?: boolean;
};

export type CombinedPriceData = {
  prices: PriceEntry[];
  avgPrice: number;
  lowThreshold: number;
  highThreshold: number;
  thresholdPercent?: number;
  minDiffOre?: number;
  lastFetched?: string;
  priceScheme?: string;
  priceUnit?: string;
};
