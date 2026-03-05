type PowerCandidate = {
  measuredPowerKw?: number;
  expectedPowerKw?: number;
  powerKw?: number;
};

export function resolveCandidatePower(device: PowerCandidate): number | null {
  if (typeof device.measuredPowerKw === 'number' && Number.isFinite(device.measuredPowerKw)) {
    return device.measuredPowerKw > 0 ? device.measuredPowerKw : null;
  }
  const expectedPower = resolveExpectedOrConfiguredPower(device.expectedPowerKw);
  if (expectedPower !== null) return expectedPower;
  const configuredPower = resolveExpectedOrConfiguredPower(device.powerKw);
  if (configuredPower !== null) return configuredPower;
  return 1;
}

function resolveExpectedOrConfiguredPower(powerKw: number | undefined): number | null {
  if (typeof powerKw !== 'number' || !Number.isFinite(powerKw)) return null;
  if (powerKw > 0) return powerKw;
  if (powerKw === 0) return 0;
  return null;
}
