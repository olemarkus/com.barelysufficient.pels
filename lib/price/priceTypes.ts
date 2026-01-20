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
  totalExVat?: number;
};

export type PriceScheme = 'norway' | 'flow' | 'homey';
