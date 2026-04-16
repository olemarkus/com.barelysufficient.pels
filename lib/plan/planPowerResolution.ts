import type { DeviceControlModel, SteppedLoadProfile } from '../utils/types';
import { getSteppedLoadRestoreStep } from '../utils/deviceControlProfiles';
import { isSteppedLoadDevice } from './planSteppedLoad';

type PowerSource = 'measured' | 'expected' | 'planning' | 'configured' | 'stepped' | 'off' | 'fallback';

export type RestorePowerSource = Exclude<PowerSource, 'off'>;

type PowerCandidate = {
  measuredPowerKw?: number;
  expectedPowerKw?: number;
  planningPowerKw?: number;
  powerKw?: number;
};

type LiveUsageCandidate = PowerCandidate & {
  currentState?: string;
  currentOn?: boolean;
};

type RestorePowerCandidate = PowerCandidate & {
  currentState?: string;
  controlModel?: DeviceControlModel;
  steppedLoadProfile?: SteppedLoadProfile;
  selectedStepId?: string;
};

function resolveFinitePowerKw(powerKw: number | undefined, allowZero: boolean): number | null {
  if (typeof powerKw !== 'number' || !Number.isFinite(powerKw)) return null;
  if (powerKw < 0) return null;
  if (!allowZero && powerKw === 0) return null;
  return powerKw;
}

function resolvePreferredPowerSource(
  device: PowerCandidate,
  allowZero: boolean,
): { source: Exclude<PowerSource, 'stepped' | 'off' | 'fallback'>; value: number } | null {
  const candidates: Array<{
    source: Exclude<PowerSource, 'stepped' | 'off' | 'fallback'>;
    value: number | undefined;
  }> = [
    { source: 'measured', value: device.measuredPowerKw },
    { source: 'expected', value: device.expectedPowerKw },
    { source: 'planning', value: device.planningPowerKw },
    { source: 'configured', value: device.powerKw },
  ];

  for (const candidate of candidates) {
    const value = resolveFinitePowerKw(candidate.value, allowZero);
    if (value !== null) return { source: candidate.source, value };
  }
  return null;
}

function resolveHighestPowerSource(
  device: PowerCandidate,
): { source: Exclude<PowerSource, 'stepped' | 'off' | 'fallback'>; value: number } | null {
  const candidates: Array<{
    source: Exclude<PowerSource, 'stepped' | 'off' | 'fallback'>;
    value: number | undefined;
  }> = [
    { source: 'measured', value: device.measuredPowerKw },
    { source: 'expected', value: device.expectedPowerKw },
    { source: 'planning', value: device.planningPowerKw },
    { source: 'configured', value: device.powerKw },
  ];

  let best: { source: Exclude<PowerSource, 'stepped' | 'off' | 'fallback'>; value: number } | null = null;
  for (const candidate of candidates) {
    const value = resolveFinitePowerKw(candidate.value, false);
    if (value === null) continue;
    if (best === null || value > best.value) {
      best = { source: candidate.source, value };
    }
  }
  return best;
}

export function resolveCandidatePower(device: PowerCandidate): number {
  return resolvePreferredPowerSource(device, true)?.value ?? 1;
}

export function resolveLiveUsagePowerKw(device: LiveUsageCandidate): number | null {
  if (
    device.currentState === 'off'
    || (
      device.currentOn === false
      && device.currentState !== 'unknown'
      && device.currentState !== 'not_applicable'
    )
  ) {
    return typeof device.measuredPowerKw === 'number' && Number.isFinite(device.measuredPowerKw)
      ? Math.max(0, device.measuredPowerKw)
      : 0;
  }
  const preferred = resolvePreferredPowerSource({
    measuredPowerKw: device.measuredPowerKw,
    expectedPowerKw: device.expectedPowerKw,
    planningPowerKw: device.planningPowerKw,
  }, true);
  if (preferred) return preferred.value;
  return null;
}

export function resolveRestorePower(device: RestorePowerCandidate): { powerKw: number; source: RestorePowerSource } {
  const steppedPower = resolveSteppedRestorePower(device);
  if (steppedPower !== null) return steppedPower;

  const preferred = resolveHighestPowerSource(device);
  if (preferred) {
    return { powerKw: preferred.value, source: preferred.source };
  }

  return { powerKw: 1, source: 'fallback' };
}

function resolveSteppedRestorePower(
  device: RestorePowerCandidate,
): { powerKw: number; source: RestorePowerSource } | null {
  if (!isSteppedLoadDevice(device) || !device.steppedLoadProfile) return null;

  if (device.currentState !== 'off' && typeof device.planningPowerKw === 'number' && device.planningPowerKw > 0) {
    return { powerKw: device.planningPowerKw, source: 'planning' };
  }

  const restoreStep = getSteppedLoadRestoreStep(device.steppedLoadProfile);
  if (restoreStep && restoreStep.planningPowerW > 0) {
    return { powerKw: restoreStep.planningPowerW / 1000, source: 'stepped' };
  }

  return null;
}
