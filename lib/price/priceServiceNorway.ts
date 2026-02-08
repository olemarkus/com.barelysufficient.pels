import { calculateElectricitySupport, getRegionalPricingRules } from './priceComponents';
import { getZonedParts } from '../utils/dateUtils';
import {
  DEFAULT_NORGESPRIS_HOURLY_USAGE_ESTIMATE_KWH,
  getNorgesprisMonthlyCapForTariffGroup,
  NORGESPRIS_TARGET_EX_VAT,
} from './norwayPriceDefaults';
import type { CombinedHourlyPrice } from './priceTypes';

export type NorwayPriceModel = 'stromstotte' | 'norgespris';

type SpotEntry = {
  startsAt: string;
  total?: number;
  spotPriceExVat?: number;
  totalExVat?: number;
};

type GridTariffEntry = {
  time?: number | string;
  energyFeeExVat?: number | null;
  energyFeeIncVat?: number | null;
  energileddEks?: number | null;
  energileddInk?: number | null;
};

type ZonedTimeInfo = {
  startsAtMs: number;
  hour: number;
  monthKey: string;
};

const getNumber = (value: unknown): number | null => (
  typeof value === 'number' && Number.isFinite(value) ? value : null
);

const formatMonthKey = (year: number, month: number): string => (
  `${year.toString().padStart(4, '0')}-${month.toString().padStart(2, '0')}`
);

const getZonedTimeInfo = (startsAt: string, timeZone: string): ZonedTimeInfo => {
  const startsAtMs = Date.parse(startsAt);
  if (!Number.isFinite(startsAtMs)) return { startsAtMs, hour: 0, monthKey: '' };
  const date = new Date(startsAtMs);
  try {
    const parts = getZonedParts(date, timeZone);
    return {
      startsAtMs,
      hour: parts.hour,
      monthKey: formatMonthKey(parts.year, parts.month),
    };
  } catch {
    return {
      startsAtMs,
      hour: date.getUTCHours(),
      monthKey: formatMonthKey(date.getUTCFullYear(), date.getUTCMonth() + 1),
    };
  }
};

const sortByStartsAtMs = (aMs: number, bMs: number): number => {
  if (!Number.isFinite(aMs) && !Number.isFinite(bMs)) return 0;
  if (!Number.isFinite(aMs)) return 1;
  if (!Number.isFinite(bMs)) return -1;
  return aMs - bMs;
};

const normalizeSpotList = (spotPrices: unknown, timeZone: string): Array<{ spot: SpotEntry; timeInfo: ZonedTimeInfo }> => {
  const spotList = Array.isArray(spotPrices) ? spotPrices as SpotEntry[] : [];
  return spotList
    .map((spot) => ({ spot, timeInfo: getZonedTimeInfo(spot.startsAt, timeZone) }))
    .sort((a, b) => sortByStartsAtMs(a.timeInfo.startsAtMs, b.timeInfo.startsAtMs));
};

const buildGridTariffByHour = (params: {
  gridTariffData: unknown;
  vatMultiplier: number;
}): Map<number, number> => {
  const { gridTariffData, vatMultiplier } = params;
  const gridTariffList = Array.isArray(gridTariffData) ? gridTariffData as GridTariffEntry[] : [];
  const gridTariffByHour = new Map<number, number>();

  for (const entry of gridTariffList) {
    const hourValue = typeof entry.time === 'number' ? entry.time : parseInt(String(entry.time ?? ''), 10);
    if (!Number.isFinite(hourValue)) continue;
    const energyFeeExVat = getNumber(entry.energyFeeExVat ?? entry.energileddEks);
    const energyFeeIncVat = getNumber(entry.energyFeeIncVat ?? entry.energileddInk);
    const resolvedExVat = energyFeeExVat ?? (energyFeeIncVat !== null ? energyFeeIncVat / vatMultiplier : null);
    if (resolvedExVat !== null) gridTariffByHour.set(hourValue, resolvedExVat);
  }

  return gridTariffByHour;
};

const resolveSpotPriceExVat = (entry: SpotEntry, vatMultiplier: number): number => {
  const exVat = getNumber(entry.spotPriceExVat ?? entry.totalExVat);
  if (exVat !== null) return exVat;
  const total = getNumber(entry.total);
  return total !== null ? total / vatMultiplier : 0;
};

const getCurrentHourStartMs = (now: Date): number => {
  const nowMs = now.getTime();
  return Number.isFinite(nowMs)
    ? Math.floor(nowMs / (60 * 60 * 1000)) * 60 * 60 * 1000
    : Number.NEGATIVE_INFINITY;
};

const resolveCurrentMonthKey = (params: {
  now: Date;
  currentMonthKey?: string;
  timeZone: string;
}): string => {
  const { now, currentMonthKey, timeZone } = params;
  if (typeof currentMonthKey === 'string' && /^\d{4}-\d{2}$/.test(currentMonthKey)) return currentMonthKey;
  return getZonedTimeInfo(now.toISOString(), timeZone).monthKey;
};

const buildRemainingCapMap = (params: {
  currentMonthKey: string;
  monthlyCapKwh: number;
  monthUsageKwh: number;
}): Map<string, number> => {
  const { currentMonthKey, monthlyCapKwh, monthUsageKwh } = params;
  const remainingByMonth = new Map<string, number>();
  remainingByMonth.set(currentMonthKey, Math.max(0, monthlyCapKwh - monthUsageKwh));
  return remainingByMonth;
};

const getRemainingCap = (params: {
  remainingByMonth: Map<string, number>;
  monthKey: string;
  monthlyCapKwh: number;
}): number => {
  const { remainingByMonth, monthKey, monthlyCapKwh } = params;
  const existing = remainingByMonth.get(monthKey);
  if (typeof existing === 'number' && Number.isFinite(existing)) return existing;
  remainingByMonth.set(monthKey, monthlyCapKwh);
  return monthlyCapKwh;
};

export const buildCombinedHourlyPricesNorway = (params: {
  spotPrices: unknown;
  gridTariffData: unknown;
  providerSurchargeIncVat: number;
  priceArea: string;
  countyCode: string;
  tariffGroup: string;
  norwayPriceModel?: NorwayPriceModel;
  monthUsageKwh?: number;
  hourlyUsageEstimateKwh?: number;
  now?: Date;
  currentMonthKey?: string;
  timeZone?: string;
}): CombinedHourlyPrice[] => {
  const {
    spotPrices,
    gridTariffData,
    providerSurchargeIncVat,
    priceArea,
    countyCode,
    tariffGroup,
    norwayPriceModel = 'stromstotte',
    monthUsageKwh = 0,
    hourlyUsageEstimateKwh = DEFAULT_NORGESPRIS_HOURLY_USAGE_ESTIMATE_KWH,
    now = new Date(),
    currentMonthKey,
    timeZone = 'UTC',
  } = params;

  const rules = getRegionalPricingRules(priceArea, countyCode);
  const vatMultiplier = rules.vatMultiplier;
  const providerSurchargeExVat = providerSurchargeIncVat / vatMultiplier;
  const normalizedTimeZone = typeof timeZone === 'string' && timeZone.trim() ? timeZone : 'UTC';
  const norgesprisEnabled = norwayPriceModel === 'norgespris';
  const monthlyCapKwh = getNorgesprisMonthlyCapForTariffGroup(tariffGroup);
  const validMonthUsageKwh = Number.isFinite(monthUsageKwh) && monthUsageKwh > 0 ? monthUsageKwh : 0;
  const validHourlyUsageEstimateKwh = Number.isFinite(hourlyUsageEstimateKwh) && hourlyUsageEstimateKwh > 0
    ? hourlyUsageEstimateKwh
    : DEFAULT_NORGESPRIS_HOURLY_USAGE_ESTIMATE_KWH;
  const norgesprisTargetIncVat = NORGESPRIS_TARGET_EX_VAT * vatMultiplier;

  const normalizedSpotList = normalizeSpotList(spotPrices, normalizedTimeZone);
  const gridTariffByHour = buildGridTariffByHour({
    gridTariffData,
    vatMultiplier,
  });
  const effectiveNow = Number.isFinite(now.getTime()) ? now : new Date();
  const currentHourStartMs = getCurrentHourStartMs(effectiveNow);
  const resolvedCurrentMonthKey = resolveCurrentMonthKey({
    now: effectiveNow,
    currentMonthKey,
    timeZone: normalizedTimeZone,
  });
  const remainingNorgesprisCapByMonth = buildRemainingCapMap({
    currentMonthKey: resolvedCurrentMonthKey,
    monthlyCapKwh,
    monthUsageKwh: validMonthUsageKwh,
  });

  return normalizedSpotList.map(({ spot, timeInfo }) => {
    const { hour, monthKey, startsAtMs } = timeInfo;
    const spotPriceExVat = resolveSpotPriceExVat(spot, vatMultiplier);
    const gridTariffExVat = gridTariffByHour.get(hour) || 0;
    const consumptionTaxExVat = rules.consumptionTaxExVat;
    const enovaFeeExVat = rules.enovaFeeExVat;
    const totalExVat = spotPriceExVat + gridTariffExVat + providerSurchargeExVat + consumptionTaxExVat + enovaFeeExVat;
    const vatAmount = totalExVat * (vatMultiplier - 1);
    const spotPriceIncVat = spotPriceExVat * vatMultiplier;

    let electricitySupportExVat = 0;
    let electricitySupport = 0;
    let norgesprisAdjustment: number | undefined;
    let norgesprisAdjustmentExVat: number | undefined;
    let totalPrice = totalExVat * vatMultiplier;

    if (norgesprisEnabled) {
      const isHistoricalHour = Number.isFinite(startsAtMs) && startsAtMs < currentHourStartMs;
      if (!isHistoricalHour) {
        const remainingNorgesprisKwh = getRemainingCap({
          remainingByMonth: remainingNorgesprisCapByMonth,
          monthKey,
          monthlyCapKwh,
        });
        const eligibleShare = remainingNorgesprisKwh <= 0
          ? 0
          : Math.min(1, remainingNorgesprisKwh / validHourlyUsageEstimateKwh);
        const updatedRemainingNorgesprisKwh = Math.max(0, remainingNorgesprisKwh - validHourlyUsageEstimateKwh);
        norgesprisAdjustment = (norgesprisTargetIncVat - spotPriceIncVat) * eligibleShare;
        norgesprisAdjustmentExVat = norgesprisAdjustment / vatMultiplier;
        totalPrice += norgesprisAdjustment;
        remainingNorgesprisCapByMonth.set(monthKey, updatedRemainingNorgesprisKwh);
      }
    } else {
      electricitySupportExVat = calculateElectricitySupport(
        spotPriceExVat,
        rules.supportThresholdExVat,
        rules.supportCoverage,
      );
      electricitySupport = electricitySupportExVat * vatMultiplier;
      totalPrice -= electricitySupport;
    }

    return {
      startsAt: spot.startsAt,
      spotPriceExVat,
      gridTariffExVat,
      providerSurchargeExVat,
      consumptionTaxExVat,
      enovaFeeExVat,
      vatMultiplier,
      vatAmount,
      electricitySupportExVat,
      electricitySupport,
      totalExVat,
      totalPrice,
      ...(typeof norgesprisAdjustmentExVat === 'number' ? { norgesprisAdjustmentExVat } : {}),
      ...(typeof norgesprisAdjustment === 'number' ? { norgesprisAdjustment } : {}),
    };
  });
};
