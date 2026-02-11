import { PriceLevel } from '../price/priceLevels';
import type { DevicePlan } from '../plan/planTypes';
import type { DevicePlanDevice } from '../plan/planTypes';

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

type LimitSource = DevicePlan['meta']['softLimitSource'];

type SharedLimitParams = {
  plan: DevicePlan;
  hasLimitDrivenShedDevices: boolean;
  headroomNegative: boolean;
};

type HourlyLimitParams = SharedLimitParams & {
  limitSource: LimitSource;
  capacitySourceActive: boolean;
};

type DailyLimitParams = SharedLimitParams & {
  dailySourceActive: boolean;
};

function hasShedReason(plan: DevicePlan, reasonFragment: string): boolean {
  return plan.devices.some((d) => d.plannedState === 'shed' && d.reason?.includes(reasonFragment));
}

function isDailySourceActive(limitSource: LimitSource): boolean {
  return limitSource === 'daily' || limitSource === 'both';
}

function isCapacitySourceActive(limitSource: LimitSource): boolean {
  return limitSource === 'capacity' || limitSource === 'both';
}

function isRestoreHoldShedReason(reason: string | undefined): boolean {
  if (!reason) return false;
  return reason.startsWith('cooldown (restore')
    || reason === 'restore throttled'
    || reason.startsWith('restore pending');
}

function isLimitDrivenShedDevice(device: DevicePlanDevice): boolean {
  if (device.plannedState !== 'shed') return false;
  return !isRestoreHoldShedReason(device.reason);
}

function hasLimitDrivenShedDevices(plan: DevicePlan): boolean {
  return plan.devices.some((d) => isLimitDrivenShedDevice(d));
}

function resolveHourlyLimited(params: HourlyLimitParams): boolean {
  const {
    plan,
    hasLimitDrivenShedDevices,
    headroomNegative,
    limitSource,
    capacitySourceActive,
  } = params;
  const hourlyLimitedByReason = hasShedReason(plan, 'hourly budget') || hasShedReason(plan, 'capacity');
  const hourlyLimitedByShedState = hasLimitDrivenShedDevices && capacitySourceActive;
  const hourlyLimitedByNegativeHeadroom = headroomNegative && (limitSource ? capacitySourceActive : true);
  return Boolean(plan.meta.hourlyBudgetExhausted)
    || hourlyLimitedByReason
    || hourlyLimitedByShedState
    || hourlyLimitedByNegativeHeadroom;
}

function resolveDailyLimited(params: DailyLimitParams): boolean {
  const { plan, hasLimitDrivenShedDevices, headroomNegative, dailySourceActive } = params;
  const dailyLimitedByReason = hasShedReason(plan, 'daily budget');
  const dailyLimitedByShedState = hasLimitDrivenShedDevices && dailySourceActive;
  const dailyLimitedByNegativeHeadroom = headroomNegative && dailySourceActive;
  return dailyLimitedByReason || dailyLimitedByShedState || dailyLimitedByNegativeHeadroom;
}

function resolveLimitReason(plan: DevicePlan): 'none' | 'hourly' | 'daily' | 'both' {
  const hasShedDevices = hasLimitDrivenShedDevices(plan);
  const headroomNegative = plan.meta.headroomKw !== null && plan.meta.headroomKw < 0;
  const limitSource = plan.meta.softLimitSource;
  const dailySourceActive = isDailySourceActive(limitSource);
  const capacitySourceActive = isCapacitySourceActive(limitSource);
  const hourlyLimited = resolveHourlyLimited({
    plan,
    hasLimitDrivenShedDevices: hasShedDevices,
    headroomNegative,
    limitSource,
    capacitySourceActive,
  });
  const dailyLimitedResolved = resolveDailyLimited({
    plan,
    hasLimitDrivenShedDevices: hasShedDevices,
    headroomNegative,
    dailySourceActive,
  });

  // When both limits are active, show 'both' for clarity, but capacity always wins for shedding decisions
  if (dailyLimitedResolved && hourlyLimited) return 'both';
  if (dailyLimitedResolved) return 'daily';
  if (hourlyLimited) return 'hourly';
  return 'none';
}
