export type CapacitySettings = {
  limitKw: number;
  marginKw: number;
};

export function resolveUsableCapacityBudgetKWh(capacitySettings: CapacitySettings): number {
  return Math.max(0, capacitySettings.limitKw - capacitySettings.marginKw);
}

export function resolveCapacitySoftLimitKw(capacitySettings: CapacitySettings): number {
  return resolveUsableCapacityBudgetKWh(capacitySettings);
}

