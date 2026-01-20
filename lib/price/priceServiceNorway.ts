import { calculateElectricitySupport, getRegionalPricingRules } from './priceComponents';
import type { CombinedHourlyPrice } from './priceTypes';

export const buildCombinedHourlyPricesNorway = (params: {
  spotPrices: unknown;
  gridTariffData: unknown;
  providerSurchargeIncVat: number;
  priceArea: string;
  countyCode: string;
}): CombinedHourlyPrice[] => {
  const {
    spotPrices,
    gridTariffData,
    providerSurchargeIncVat,
    priceArea,
    countyCode,
  } = params;
  const spotList = Array.isArray(spotPrices)
    ? spotPrices as Array<{ startsAt: string; total?: number; spotPriceExVat?: number; totalExVat?: number }>
    : [];
  const gridTariffList = Array.isArray(gridTariffData)
    ? gridTariffData as Array<{
      time?: number | string;
      energyFeeExVat?: number | null;
      energyFeeIncVat?: number | null;
      energileddEks?: number | null;
      energileddInk?: number | null;
    }>
    : [];

  const rules = getRegionalPricingRules(priceArea, countyCode);
  const providerSurchargeExVat = providerSurchargeIncVat / rules.vatMultiplier;

  const getNumber = (value: unknown): number | null => (
    typeof value === 'number' && Number.isFinite(value) ? value : null
  );

  const gridTariffByHour = new Map<number, number>();
  for (const entry of gridTariffList) {
    const hourValue = typeof entry.time === 'number' ? entry.time : parseInt(String(entry.time ?? ''), 10);
    if (Number.isNaN(hourValue)) continue;
    const energyFeeExVat = getNumber(entry.energyFeeExVat ?? entry.energileddEks);
    const energyFeeIncVat = getNumber(entry.energyFeeIncVat ?? entry.energileddInk);
    const resolvedExVat = energyFeeExVat ?? (energyFeeIncVat !== null ? energyFeeIncVat / rules.vatMultiplier : null);
    if (resolvedExVat !== null) {
      gridTariffByHour.set(hourValue, resolvedExVat);
    }
  }

  const resolveSpotPriceExVat = (entry: { total?: number; spotPriceExVat?: number; totalExVat?: number }): number => {
    const exVat = getNumber(entry.spotPriceExVat ?? entry.totalExVat);
    if (exVat !== null) return exVat;
    const total = getNumber(entry.total);
    return total !== null ? total / rules.vatMultiplier : 0;
  };

  return spotList.map((spot) => {
    const date = new Date(spot.startsAt);
    const hour = date.getHours();
    const spotPriceExVat = resolveSpotPriceExVat(spot);
    const gridTariffExVat = gridTariffByHour.get(hour) || 0;
    const consumptionTaxExVat = rules.consumptionTaxExVat;
    const enovaFeeExVat = rules.enovaFeeExVat;
    const totalExVat = spotPriceExVat + gridTariffExVat + providerSurchargeExVat + consumptionTaxExVat + enovaFeeExVat;
    const electricitySupportExVat = calculateElectricitySupport(
      spotPriceExVat,
      rules.supportThresholdExVat,
      rules.supportCoverage,
    );
    const vatAmount = totalExVat * (rules.vatMultiplier - 1);
    const electricitySupport = electricitySupportExVat * rules.vatMultiplier;
    const totalPrice = totalExVat * rules.vatMultiplier - electricitySupport;
    return {
      startsAt: spot.startsAt,
      spotPriceExVat,
      gridTariffExVat,
      providerSurchargeExVat,
      consumptionTaxExVat,
      enovaFeeExVat,
      vatMultiplier: rules.vatMultiplier,
      vatAmount,
      electricitySupportExVat,
      electricitySupport,
      totalExVat,
      totalPrice,
    };
  }).sort((a, b) => new Date(a.startsAt).getTime() - new Date(b.startsAt).getTime());
};
