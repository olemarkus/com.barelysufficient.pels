import { PriceLevel } from '../price/priceLevels';
import type { DevicePlan } from '../plan/planTypes';

export function buildPelsStatus(params: {
  plan: DevicePlan;
  isCheap: boolean;
  isExpensive: boolean;
  combinedPrices: unknown;
  lastPowerUpdate: number | null;
}): {
  status: {
    headroomKw: number | null;
    hourlyLimitKw?: number;
    hourlyUsageKwh: number;
    dailyBudgetRemainingKwh?: number;
    dailyBudgetExceeded?: boolean;
    limitReason?: 'none' | 'hourly' | 'daily' | 'both';
    controlledKw?: number;
    uncontrolledKw?: number;
    priceLevel: PriceLevel;
    devicesOn: number;
    devicesOff: number;
    lastPowerUpdate: number | null;
  }; priceLevel: PriceLevel
} {
  const { plan, isCheap, isExpensive, combinedPrices, lastPowerUpdate } = params;
  const priceLevel = resolvePriceLevel({ isCheap, isExpensive, combinedPrices });
  const { devicesOn, devicesOff } = countDevices(plan);
  const limitReason = resolveLimitReason(plan);

  return {
    status: {
      headroomKw: plan.meta.headroomKw,
      hourlyLimitKw: plan.meta.softLimitKw,
      hourlyUsageKwh: plan.meta.usedKWh ?? 0,
      dailyBudgetRemainingKwh: plan.meta.dailyBudgetRemainingKWh ?? 0,
      dailyBudgetExceeded: plan.meta.dailyBudgetExceeded ?? false,
      limitReason,
      controlledKw: plan.meta.controlledKw,
      uncontrolledKw: plan.meta.uncontrolledKw,
      priceLevel,
      devicesOn,
      devicesOff,
      lastPowerUpdate,
    },
    priceLevel,
  };
}

function resolvePriceLevel(params: {
  isCheap: boolean;
  isExpensive: boolean;
  combinedPrices: unknown;
}): PriceLevel {
  const { isCheap, isExpensive, combinedPrices } = params;
  if (!hasPrices(combinedPrices)) return PriceLevel.UNKNOWN;
  if (isCheap) return PriceLevel.CHEAP;
  if (isExpensive) return PriceLevel.EXPENSIVE;
  return PriceLevel.NORMAL;
}

function countDevices(plan: DevicePlan): { devicesOn: number; devicesOff: number } {
  const controllable = plan.devices.filter((d) => d.controllable !== false);
  const devicesShed = controllable.filter((d) => d.plannedState === 'shed').length;
  return { devicesOn: controllable.length - devicesShed, devicesOff: devicesShed };
}

function hasPrices(value: unknown): value is { prices: Array<{ total: number }> } {
  if (!value || typeof value !== 'object') return false;
  const record = value as { prices?: unknown };
  return Array.isArray(record.prices) && record.prices.length > 0;
}

function resolveLimitReason(plan: DevicePlan): 'none' | 'hourly' | 'daily' | 'both' {
  const dailyLimited = plan.devices.some((d) => d.plannedState === 'shed' && d.reason?.includes('daily budget'));
  const headroomNegative = plan.meta.headroomKw !== null && plan.meta.headroomKw < 0;
  const limitSource = plan.meta.softLimitSource;
  const dailySourceActive = limitSource === 'daily' || limitSource === 'both';
  const capacitySourceActive = limitSource === 'capacity' || limitSource === 'both';
  const hourlyLimited = Boolean(plan.meta.hourlyBudgetExhausted)
    || plan.devices.some((d) => d.plannedState === 'shed' && d.reason?.includes('hourly budget'))
    || plan.devices.some((d) => d.plannedState === 'shed' && d.reason?.includes('capacity'))
    || (headroomNegative && (limitSource ? capacitySourceActive : true));
  const dailyLimitedResolved = dailyLimited || (headroomNegative && dailySourceActive);

  if (dailyLimitedResolved && hourlyLimited) return 'both';
  if (dailyLimitedResolved) return 'daily';
  if (hourlyLimited) return 'hourly';
  return 'none';
}
