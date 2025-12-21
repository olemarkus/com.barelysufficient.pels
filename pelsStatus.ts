import { PriceLevel } from './priceLevels';
import type { DevicePlan } from './planTypes';

export function buildPelsStatus(params: {
  plan: DevicePlan;
  isCheap: boolean;
  isExpensive: boolean;
  combinedPrices: unknown;
  lastPowerUpdate: number | null;
}): { status: {
  headroomKw: number | null;
  hourlyUsageKwh: number;
  shedding: boolean;
  priceLevel: PriceLevel;
  devicesOn: number;
  devicesOff: number;
  lastPowerUpdate: number | null;
}; priceLevel: PriceLevel } {
  const { plan, isCheap, isExpensive, combinedPrices, lastPowerUpdate } = params;
  const priceLevel = resolvePriceLevel({ isCheap, isExpensive, combinedPrices });
  const hasShedding = plan.devices.some((d) => d.plannedState === 'shed');
  const { devicesOn, devicesOff } = countDevices(plan);

  return {
    status: {
      headroomKw: plan.meta.headroomKw,
      hourlyUsageKwh: plan.meta.usedKWh ?? 0,
      shedding: hasShedding,
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
  const devicesOn = controllable.filter((d) => {
    const treatedAsOff = d.plannedState === 'shed' && d.shedAction !== 'set_temperature';
    return d.currentState === 'on' && !treatedAsOff;
  }).length;
  const devicesOff = controllable.filter((d) => {
    const treatedAsOff = d.plannedState === 'shed' && d.shedAction !== 'set_temperature';
    return d.currentState === 'off' || treatedAsOff;
  }).length;
  return { devicesOn, devicesOff };
}

function hasPrices(value: unknown): value is { prices: Array<{ total: number }> } {
  if (!value || typeof value !== 'object') return false;
  const record = value as { prices?: unknown };
  return Array.isArray(record.prices) && record.prices.length > 0;
}
