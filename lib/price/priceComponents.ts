export type RegionalPricingRules = {
  vatMultiplier: number;
  consumptionTaxExVat: number;
  enovaFeeExVat: number;
  supportThresholdExVat: number;
  supportCoverage: number;
  hasVat: boolean;
  usesReducedConsumptionTax: boolean;
};

export const VAT_MULTIPLIER_STANDARD = 1.25;
export const VAT_MULTIPLIER_EXEMPT = 1.0;

export const CONSUMPTION_TAX_STANDARD_EX_VAT = 7.13;
export const CONSUMPTION_TAX_REDUCED_EX_VAT = 0.48;

export const ENOVA_FEE_EX_VAT = 1.0;

export const ELECTRICITY_SUPPORT_THRESHOLD_EX_VAT = 77;
export const ELECTRICITY_SUPPORT_COVERAGE = 0.90;

const REDUCED_CONSUMPTION_TAX_COUNTIES = new Set(['55', '56']);

export const getVatMultiplier = (priceArea: string): number => (
  priceArea === 'NO4' ? VAT_MULTIPLIER_EXEMPT : VAT_MULTIPLIER_STANDARD
);

export const getConsumptionTaxRate = (countyCode: string): number => (
  REDUCED_CONSUMPTION_TAX_COUNTIES.has(countyCode)
    ? CONSUMPTION_TAX_REDUCED_EX_VAT
    : CONSUMPTION_TAX_STANDARD_EX_VAT
);

export const calculateElectricitySupport = (
  spotPriceExVat: number,
  thresholdExVat = ELECTRICITY_SUPPORT_THRESHOLD_EX_VAT,
  coverage = ELECTRICITY_SUPPORT_COVERAGE,
): number => (
  spotPriceExVat > thresholdExVat
    ? (spotPriceExVat - thresholdExVat) * coverage
    : 0
);

export const getRegionalPricingRules = (priceArea: string, countyCode: string): RegionalPricingRules => {
  const vatMultiplier = getVatMultiplier(priceArea);
  const consumptionTaxExVat = getConsumptionTaxRate(countyCode);
  return {
    vatMultiplier,
    consumptionTaxExVat,
    enovaFeeExVat: ENOVA_FEE_EX_VAT,
    supportThresholdExVat: ELECTRICITY_SUPPORT_THRESHOLD_EX_VAT,
    supportCoverage: ELECTRICITY_SUPPORT_COVERAGE,
    hasVat: vatMultiplier !== VAT_MULTIPLIER_EXEMPT,
    usesReducedConsumptionTax: consumptionTaxExVat !== CONSUMPTION_TAX_STANDARD_EX_VAT,
  };
};
