type PowerCandidate = {
  measuredPowerKw?: number;
  expectedPowerKw?: number;
  planningPowerKw?: number;
  powerKw?: number;
};

const DEFAULT_FALLBACK_POWER_KW = 1;

export function resolveCandidatePower(device: PowerCandidate): number | null {
  if (typeof device.measuredPowerKw === 'number' && Number.isFinite(device.measuredPowerKw)) {
    return device.measuredPowerKw > 0 ? device.measuredPowerKw : null;
  }
  const expectedPower = resolveExpectedOrConfiguredPower(device.expectedPowerKw);
  if (expectedPower !== null) return expectedPower;
  const planningPower = resolveExpectedOrConfiguredPower(device.planningPowerKw);
  if (planningPower !== null) return planningPower;
  const configuredPower = resolveExpectedOrConfiguredPower(device.powerKw);
  if (configuredPower !== null) return configuredPower;
  return DEFAULT_FALLBACK_POWER_KW;
}

function resolveExpectedOrConfiguredPower(powerKw: number | undefined): number | null {
  if (typeof powerKw === 'number' && Number.isFinite(powerKw) && powerKw >= 0) return powerKw;
  return null;
}
