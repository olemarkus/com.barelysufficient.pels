type UsageDevice = {
  controllable?: boolean;
  budgetExempt?: boolean;
  measuredPowerKw?: number;
  expectedPowerKw?: number;
};

const resolveUsageKw = (
  dev: UsageDevice,
  allowExpectedFallback: boolean,
): number | null => {
  const measured = typeof dev.measuredPowerKw === 'number' && Number.isFinite(dev.measuredPowerKw)
    ? dev.measuredPowerKw
    : null;
  if (measured !== null) return measured;
  if (!allowExpectedFallback) return null;
  const expected = typeof dev.expectedPowerKw === 'number' && Number.isFinite(dev.expectedPowerKw)
    ? dev.expectedPowerKw
    : null;
  return expected;
};

export const sumControlledUsageKw = (devices: UsageDevice[]): number | null => {
  let totalKw = 0;
  let hasUsage = false;
  let hasControllable = false;
  for (const dev of devices) {
    if (dev.controllable === false) continue;
    hasControllable = true;
    const usage = resolveUsageKw(dev, true);
    if (usage === null) continue;
    totalKw += usage;
    hasUsage = true;
  }
  if (!hasControllable) return 0;
  return hasUsage ? totalKw : null;
};

export const sumBudgetExemptLiveUsageKw = (devices: UsageDevice[]): number | null => {
  return sumBudgetExemptUsageKwInternal(devices, true);
};

const sumBudgetExemptUsageKwInternal = (
  devices: UsageDevice[],
  allowExpectedFallback: boolean,
): number | null => {
  let totalKw = 0;
  let hasExempt = false;
  let hasUsage = false;
  for (const dev of devices) {
    if (dev.budgetExempt !== true || dev.controllable === false) continue;
    hasExempt = true;
    const usage = resolveUsageKw(dev, allowExpectedFallback);
    if (usage === null) continue;
    totalKw += usage;
    hasUsage = true;
  }
  if (!hasExempt) return 0;
  return hasUsage ? totalKw : null;
};
