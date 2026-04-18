import { PriceLevel } from '../price/priceLevels';
import { PLAN_REASON_CODES, type DeviceReason } from '../../packages/shared-domain/src/planReasonSemantics';
import type { DevicePlan } from '../plan/planTypes';
import type { DevicePlanDevice } from '../plan/planTypes';
import { NEUTRAL_STARTUP_HOLD_REASON } from '../plan/planRestoreDevices';

export function buildPelsStatus(params: {
  plan: DevicePlan;
  isCheap: boolean;
  isExpensive: boolean;
  combinedPrices: unknown;
  lastPowerUpdate: number | null;
}): {
  status: {
    headroomKw: number;
    hourlyLimitKw?: number;
    hourlyUsageKwh: number;
    dailyBudgetRemainingKwh?: number;
    dailyBudgetExceeded?: boolean;
    limitReason?: 'none' | 'hourly' | 'daily' | 'both';
    capacityShortfall?: boolean;
    shortfallBudgetThresholdKw?: number;
    shortfallBudgetHeadroomKw?: number | null;
    hardCapHeadroomKw?: number | null;
    controlledKw?: number;
    uncontrolledKw?: number;
    powerKnown?: boolean;
    hasLivePowerSample?: boolean;
    powerFreshnessState?: DevicePlan['meta']['powerFreshnessState'];
    priceLevel: PriceLevel;
    devicesOn: number;
    devicesOff: number;
    lastPowerUpdate: number | null;
  }; priceLevel: PriceLevel
} {
  const { plan, isCheap, isExpensive, combinedPrices, lastPowerUpdate } = params;
  const priceLevel = resolvePriceLevel({ isCheap, isExpensive, combinedPrices });
  const summary = summarizePlanForStatus(plan);
  const limitReason = resolveLimitReason(plan, summary);

  return {
    status: {
      headroomKw: plan.meta.headroomKw,
      hourlyLimitKw: plan.meta.softLimitKw,
      hourlyUsageKwh: plan.meta.usedKWh ?? 0,
      dailyBudgetRemainingKwh: plan.meta.dailyBudgetRemainingKWh ?? 0,
      dailyBudgetExceeded: plan.meta.dailyBudgetExceeded ?? false,
      limitReason,
      capacityShortfall: plan.meta.capacityShortfall ?? false,
      shortfallBudgetThresholdKw: plan.meta.shortfallBudgetThresholdKw,
      shortfallBudgetHeadroomKw: plan.meta.shortfallBudgetHeadroomKw,
      hardCapHeadroomKw: plan.meta.hardCapHeadroomKw,
      controlledKw: plan.meta.controlledKw,
      uncontrolledKw: plan.meta.uncontrolledKw,
      powerKnown: plan.meta.powerKnown,
      hasLivePowerSample: plan.meta.hasLivePowerSample,
      powerFreshnessState: plan.meta.powerFreshnessState,
      priceLevel,
      devicesOn: summary.devicesOn,
      devicesOff: summary.devicesOff,
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

function hasPrices(value: unknown): value is { prices: Array<{ total: number }> } {
  if (!value || typeof value !== 'object') return false;
  const record = value as { prices?: unknown };
  return Array.isArray(record.prices) && record.prices.length > 0;
}

type LimitSource = DevicePlan['meta']['softLimitSource'];

type SharedLimitParams = {
  plan: DevicePlan;
  summary: PlanStatusSummary;
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

type PlanStatusSummary = {
  devicesOn: number;
  devicesOff: number;
  hasLimitDrivenShedDevices: boolean;
  hasHourlyReason: boolean;
  hasDailyReason: boolean;
};

function isDailySourceActive(limitSource: LimitSource): boolean {
  return limitSource === 'daily' || limitSource === 'both';
}

function isCapacitySourceActive(limitSource: LimitSource): boolean {
  return limitSource === 'capacity' || limitSource === 'both';
}

function isRestoreHoldShedReason(reason: DeviceReason | undefined): boolean {
  if (!reason) return false;
  return reason.code === PLAN_REASON_CODES.meterSettling
    || reason.code === PLAN_REASON_CODES.cooldownRestore
    || reason.code === PLAN_REASON_CODES.restoreThrottled
    || reason.code === NEUTRAL_STARTUP_HOLD_REASON.code
    || reason.code === PLAN_REASON_CODES.restorePending;
}

function isLimitDrivenShedDevice(device: DevicePlanDevice): boolean {
  if (device.plannedState !== 'shed') return false;
  return !isRestoreHoldShedReason(device.reason);
}

function resolveReasonFlags(reason: DeviceReason | undefined): {
  hasHourlyReason: boolean;
  hasDailyReason: boolean;
} {
  if (!reason) {
    return {
      hasHourlyReason: false,
      hasDailyReason: false,
    };
  }
  if (reason.code === NEUTRAL_STARTUP_HOLD_REASON.code) {
    return {
      hasHourlyReason: false,
      hasDailyReason: false,
    };
  }
  return {
    hasHourlyReason: reason.code === PLAN_REASON_CODES.hourlyBudget || reason.code === PLAN_REASON_CODES.capacity,
    hasDailyReason: reason.code === PLAN_REASON_CODES.dailyBudget,
  };
}

function summarizePlanForStatus(plan: DevicePlan): PlanStatusSummary {
  const summary: PlanStatusSummary = {
    devicesOn: 0,
    devicesOff: 0,
    hasLimitDrivenShedDevices: false,
    hasHourlyReason: false,
    hasDailyReason: false,
  };

  for (const device of plan.devices) {
    if (device.controllable !== false) {
      if (device.plannedState === 'shed') {
        summary.devicesOff += 1;
      } else if (device.plannedState === 'keep') {
        summary.devicesOn += 1;
      }
    }

    if (device.plannedState !== 'shed') continue;

    const reasonFlags = resolveReasonFlags(device.reason);
    summary.hasHourlyReason = summary.hasHourlyReason || reasonFlags.hasHourlyReason;
    summary.hasDailyReason = summary.hasDailyReason || reasonFlags.hasDailyReason;
    summary.hasLimitDrivenShedDevices = summary.hasLimitDrivenShedDevices || isLimitDrivenShedDevice(device);
  }

  return summary;
}

function resolveHourlyLimited(params: HourlyLimitParams): boolean {
  const {
    plan,
    summary,
    hasLimitDrivenShedDevices,
    headroomNegative,
    limitSource,
    capacitySourceActive,
  } = params;
  const hourlyLimitedByReason = summary.hasHourlyReason;
  const hourlyLimitedByShedState = hasLimitDrivenShedDevices && capacitySourceActive;
  const hourlyLimitedByNegativeHeadroom = headroomNegative && (limitSource ? capacitySourceActive : true);
  return Boolean(plan.meta.hourlyBudgetExhausted)
    || hourlyLimitedByReason
    || hourlyLimitedByShedState
    || hourlyLimitedByNegativeHeadroom;
}

function resolveDailyLimited(params: DailyLimitParams): boolean {
  const { summary, hasLimitDrivenShedDevices, headroomNegative, dailySourceActive } = params;
  const dailyLimitedByReason = summary.hasDailyReason;
  const dailyLimitedByShedState = hasLimitDrivenShedDevices && dailySourceActive;
  const dailyLimitedByNegativeHeadroom = headroomNegative && dailySourceActive;
  return dailyLimitedByReason || dailyLimitedByShedState || dailyLimitedByNegativeHeadroom;
}

function resolveLimitReason(plan: DevicePlan, summary: PlanStatusSummary): 'none' | 'hourly' | 'daily' | 'both' {
  const hasShedDevices = summary.hasLimitDrivenShedDevices;
  const headroomNegative = plan.meta.headroomKw < 0;
  const limitSource = plan.meta.softLimitSource;
  const dailySourceActive = isDailySourceActive(limitSource);
  const capacitySourceActive = isCapacitySourceActive(limitSource);
  const hourlyLimited = resolveHourlyLimited({
    plan,
    summary,
    hasLimitDrivenShedDevices: hasShedDevices,
    headroomNegative,
    limitSource,
    capacitySourceActive,
  });
  const dailyLimitedResolved = resolveDailyLimited({
    plan,
    summary,
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
