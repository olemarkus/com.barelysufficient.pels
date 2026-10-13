import type { NorwayPriceParts } from './combinedPrices.ts';

/** One part of the price now, with VAT, in the price's own unit. */
export type PriceBreakdownPart = {
  label: 'Spot' | 'Norgespris' | 'grid tariff' | 'surcharge' | 'taxes' | 'support';
  value: number;
};

/**
 * The Norway price now as the parts that add up to it, with VAT. Norgespris is
 * the adjustment that brings the spot price to the fixed price, signed: under
 * the monthly cap it covers only part of the hour, or none of it once the cap
 * is used. Strømstøtte is subtracted as `support`. A part that is zero is left
 * out, except the spot price itself.
 */
export const resolvePriceBreakdown = (parts: NorwayPriceParts): PriceBreakdownPart[] => {
  const withVat = (exVat: number): number => exVat * parts.vatMultiplier;
  const breakdown: PriceBreakdownPart[] = [
    { label: 'Spot', value: withVat(parts.spotExVat) },
    ...(parts.relief.kind === 'norgespris'
      ? [{ label: 'Norgespris' as const, value: parts.relief.adjustmentIncVat }]
      : []),
    { label: 'grid tariff', value: withVat(parts.gridTariffExVat) },
    { label: 'surcharge', value: withVat(parts.providerSurchargeExVat) },
    { label: 'taxes', value: withVat(parts.taxesExVat) },
    ...(parts.relief.kind === 'stromstotte'
      ? [{ label: 'support' as const, value: -parts.relief.supportIncVat }]
      : []),
  ];
  return breakdown.filter((part, index) => index === 0 || part.value !== 0);
};
