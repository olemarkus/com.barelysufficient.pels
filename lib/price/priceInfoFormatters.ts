import type { CombinedPriceFields } from './priceTypes';

export const formatFlowPriceInfo = (
  current: CombinedPriceFields,
  priceUnitLabel: string,
): string => `${current.totalPrice.toFixed(4)} ${priceUnitLabel} (as provided)`;

export const formatNorwayPriceInfo = (current: CombinedPriceFields): string => {
  const format = (value: number | undefined): string => (value ?? 0).toFixed(1);
  const hasNorgesprisAdjustment = typeof current.norgesprisAdjustment === 'number'
    && Number.isFinite(current.norgesprisAdjustment);
  const norgesprisMagnitude = Math.abs(current.norgesprisAdjustment ?? 0);
  const norgesprisOperator = (current.norgesprisAdjustment ?? 0) < 0 ? '-' : '+';
  const supportSegment = hasNorgesprisAdjustment
    ? ` ${norgesprisOperator} norgespris adjustment ${norgesprisMagnitude.toFixed(1)}`
    : ` - electricity support ${format(current.electricitySupport)}`;
  return `${current.totalPrice.toFixed(1)} øre/kWh (spot price ${format(current.spotPriceExVat)} ex VAT`
    + ` + grid tariff ${format(current.gridTariffExVat)}`
    + ` + surcharge ${format(current.providerSurchargeExVat)}`
    + ` + consumption tax ${format(current.consumptionTaxExVat)}`
    + ` + Enova fee ${format(current.enovaFeeExVat)}`
    + ` + VAT ${format(current.vatAmount)}`
    + `${supportSegment})`;
};
