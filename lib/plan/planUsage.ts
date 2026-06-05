import { getHighestKnownPowerKw, getMeasuredDrawKw } from '../observer/observedPower';
import { isObservedOff } from '../observer/observedState';
import { isFiniteNumber } from '../utils/appTypeGuards';

type UsageDevice = {
  controllable?: boolean;
  budgetExempt?: boolean;
  binaryControl?: { on: boolean };
  currentState?: string;
  controlCapabilityId?: 'onoff' | 'evcharger_charging';
  plannedState?: string;
  measuredPowerKw?: number;
  expectedPowerKw?: number;
  planningPowerKw?: number;
  powerKw?: number;
};

function isFiniteNonNegative(value: number | undefined): value is number {
  return isFiniteNumber(value) && value >= 0;
}

// Live usage attribution. Plan-state-aware composition over Observer primitives —
// the rules differ by plannedState and observed binary state, so this stays on the
// plan side. Behavior preserved from the previous resolveLiveUsagePowerKw helper.
const resolveShedUsageKw = (dev: UsageDevice, measured: number | null): number | null => {
  if (measured !== null) return measured;
  return isObservedOff(dev) ? 0 : null;
};

const resolveObservedOffUsageKw = (dev: UsageDevice, measured: number | null): number => {
  if (measured !== null && measured > 0) return measured;
  const highest = getHighestKnownPowerKw(dev);
  if (highest !== null) return highest.kw;
  return measured ?? 0;
};

const resolveObservedOnUsageKw = (dev: UsageDevice, measured: number | null): number | null => {
  // Measured wins when present, including a measured 0 — that matches the
  // pre-refactor `resolveLiveUsagePowerKw` behavior of allowZero on the priority walk.
  if (measured !== null) return measured;
  if (isFiniteNonNegative(dev.expectedPowerKw)) return dev.expectedPowerKw;
  if (isFiniteNonNegative(dev.planningPowerKw)) return dev.planningPowerKw;
  return null;
};

const resolveUsageKw = (dev: UsageDevice): number | null => {
  const measured = getMeasuredDrawKw(dev);
  if (dev.plannedState === 'shed') return resolveShedUsageKw(dev, measured);
  if (isObservedOff(dev)) return resolveObservedOffUsageKw(dev, measured);
  return resolveObservedOnUsageKw(dev, measured);
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
