type PowerCandidate = {
  measuredPowerKw?: number;
  expectedPowerKw?: number;
  powerKw?: number;
};

export function resolveCandidatePower(device: PowerCandidate): number | null {
  if (typeof device.measuredPowerKw === 'number' && Number.isFinite(device.measuredPowerKw)) {
    return device.measuredPowerKw > 0 ? device.measuredPowerKw : null;
  }
  if (typeof device.expectedPowerKw === 'number' && Number.isFinite(device.expectedPowerKw)) {
    return Math.max(0, device.expectedPowerKw);
  }
  if (typeof device.powerKw === 'number' && Number.isFinite(device.powerKw)) {
    return Math.max(0, device.powerKw);
  }
  return 1;
}
