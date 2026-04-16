import { resolveEffectiveCurrentOn } from './planCurrentState';
import { resolveLiveUsagePowerKw } from './planPowerResolution';

type UsageDevice = {
  controllable?: boolean;
  budgetExempt?: boolean;
  currentOn?: boolean;
  currentState?: string;
  plannedState?: string;
  measuredPowerKw?: number;
  expectedPowerKw?: number;
  planningPowerKw?: number;
  powerKw?: number;
};

const resolveUsageKw = (dev: UsageDevice): number | null => {
  if (dev.plannedState === 'shed') {
    if (typeof dev.measuredPowerKw === 'number' && Number.isFinite(dev.measuredPowerKw)) {
      return Math.max(0, dev.measuredPowerKw);
    }
    if (resolveEffectiveCurrentOn(dev) === false) {
      return 0;
    }
    return null;
  }
  return resolveLiveUsagePowerKw(dev);
};

export const sumControlledUsageKw = (devices: UsageDevice[]): number | null => {
  let totalKw = 0;
  let hasUsage = false;
  let hasControllable = false;
  for (const dev of devices) {
    if (dev.controllable === false) continue;
    hasControllable = true;
    const usage = resolveUsageKw(dev);
    if (usage === null) continue;
    totalKw += usage;
    hasUsage = true;
  }
  if (!hasControllable) return 0;
  return hasUsage ? totalKw : null;
};

export const sumBudgetExemptLiveUsageKw = (devices: UsageDevice[]): number | null => {
  return sumBudgetExemptUsageKwInternal(devices);
};

export function splitControlledUsageKw(params: {
  devices: UsageDevice[];
  totalKw: number | null;
}): { controlledKw: number | null; uncontrolledKw: number | null } {
  const { devices, totalKw } = params;
  const controlledKw = sumControlledUsageKw(devices);
  const boundedControlledKw = totalKw !== null && controlledKw !== null
    ? Math.max(0, Math.min(totalKw, controlledKw))
    : controlledKw;
  return {
    controlledKw: boundedControlledKw,
    uncontrolledKw: totalKw !== null && boundedControlledKw !== null
      ? Math.max(0, totalKw - boundedControlledKw)
      : null,
  };
}

const sumBudgetExemptUsageKwInternal = (
  devices: UsageDevice[],
): number | null => {
  let totalKw = 0;
  let hasExempt = false;
  let hasUsage = false;
  for (const dev of devices) {
    if (dev.budgetExempt !== true || dev.controllable === false) continue;
    hasExempt = true;
    const usage = resolveUsageKw(dev);
    if (usage === null) continue;
    totalKw += usage;
    hasUsage = true;
  }
  if (!hasExempt) return 0;
  return hasUsage ? totalKw : null;
};
