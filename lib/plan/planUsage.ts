type UsageDevice = {
  controllable?: boolean;
  measuredPowerKw?: number;
  expectedPowerKw?: number;
};

export const sumControlledUsageKw = (devices: UsageDevice[]): number | null => {
  let totalKw = 0;
  let hasUsage = false;
  devices.forEach((dev) => {
    if (dev.controllable === false) return;
    const measured = typeof dev.measuredPowerKw === 'number' && Number.isFinite(dev.measuredPowerKw)
      ? dev.measuredPowerKw
      : null;
    const expected = typeof dev.expectedPowerKw === 'number' && Number.isFinite(dev.expectedPowerKw)
      ? dev.expectedPowerKw
      : null;
    const usage = measured ?? expected;
    if (usage === null) return;
    totalKw += usage;
    hasUsage = true;
  });
  return hasUsage ? totalKw : null;
};
