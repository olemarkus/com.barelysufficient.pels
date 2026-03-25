import type { DevicePlanDevice } from './planTypes';
import { resolveCandidatePower } from './planCandidatePower';
import { isSteppedLoadDevice } from './planSteppedLoad';
import { getSteppedLoadRestoreStep } from '../utils/deviceControlProfiles';

function isViableSwapCandidate(
  onDev: DevicePlanDevice,
  dev: DevicePlanDevice,
  swappedOutFor: ReadonlyMap<string, string>,
  restoredThisCycle: ReadonlySet<string>,
): boolean {
  const onDevPriority = onDev.priority ?? 100;
  const devPriority = dev.priority ?? 100;
  if (onDevPriority <= devPriority) return false;
  if (onDev.plannedState === 'shed') return false;
  if (swappedOutFor.has(onDev.id)) return false;
  if (restoredThisCycle.has(onDev.id)) return false;
  return true;
}

export function buildSwapCandidates(params: {
  dev: DevicePlanDevice;
  onDevices: DevicePlanDevice[];
  swappedOutFor: ReadonlyMap<string, string>;
  availableHeadroom: number;
  needed: number;
  restoredThisCycle: ReadonlySet<string>;
}): {
  ready: boolean;
  toShed: DevicePlanDevice[];
  shedNames: string;
  shedPower: string;
  potentialHeadroom: number;
  shedPowerByDeviceId: Map<string, number>;
  reason: string;
} {
  const {
    dev,
    onDevices,
    swappedOutFor,
    availableHeadroom,
    needed,
    restoredThisCycle,
  } = params;
  const toShed: DevicePlanDevice[] = [];
  const shedPowerByDeviceId = new Map<string, number>();
  let currentPotential = availableHeadroom;

  for (const onDev of onDevices) {
    if (!isViableSwapCandidate(onDev, dev, swappedOutFor, restoredThisCycle)) continue;

    const pwr = resolveCandidatePower(onDev);
    if (pwr === null || pwr <= 0) continue;

    toShed.push(onDev);
    shedPowerByDeviceId.set(onDev.id, pwr);
    currentPotential += pwr;

    if (currentPotential >= needed) break;
  }

  const ready = currentPotential >= needed;
  const names = toShed.map((d) => d.name).join(', ');
  const reason = ready
    ? `swapped out for ${dev.name}`
    : `insufficient headroom to swap for ${dev.name} (need ${needed.toFixed(2)}kW, `
    + `potential ${currentPotential.toFixed(2)}kW from ${names || 'none'})`;

  return {
    ready,
    toShed,
    shedNames: names,
    shedPower: (currentPotential - availableHeadroom).toFixed(2),
    potentialHeadroom: currentPotential,
    shedPowerByDeviceId,
    reason,
  };
}

export function buildInsufficientHeadroomUpdate(needed: number, available: number): Partial<DevicePlanDevice> {
  return {
    plannedState: 'shed',
    reason: `insufficient headroom to restore (need ${needed.toFixed(2)}kW, `
      + `available ${available.toFixed(2)}kW)`,
  };
}

export function computeRestoreBufferKw(devPower: number): number {
  const boundedPower = Math.max(0, devPower);
  const scaled = boundedPower * 0.1 + 0.1;
  return Math.max(0.2, Math.min(0.6, scaled));
}

export function estimateRestorePower(dev: DevicePlanDevice): number {
  const steppedPower = resolveSteppedRestorePower(dev);
  if (steppedPower !== null) return steppedPower;

  if (typeof dev.planningPowerKw === 'number' && dev.planningPowerKw > 0) return dev.planningPowerKw;
  if (typeof dev.expectedPowerKw === 'number') return dev.expectedPowerKw;
  if (typeof dev.measuredPowerKw === 'number' && dev.measuredPowerKw > 0) return dev.measuredPowerKw;
  return dev.powerKw ?? 1;
}

function resolveSteppedRestorePower(dev: DevicePlanDevice): number | null {
  if (!isSteppedLoadDevice(dev) || !dev.steppedLoadProfile) return null;

  if (dev.currentState !== 'off' && typeof dev.planningPowerKw === 'number' && dev.planningPowerKw > 0) {
    return dev.planningPowerKw;
  }

  // For stepped devices that are off, or on with zero planning power, use the
  // lowest non-zero step as the conservative re-entry estimate.
  const restoreStep = getSteppedLoadRestoreStep(dev.steppedLoadProfile);
  if (restoreStep && restoreStep.planningPowerW > 0) return restoreStep.planningPowerW / 1000;

  return null;
}

export function computeBaseRestoreNeed(dev: DevicePlanDevice): { power: number; buffer: number; needed: number } {
  const power = estimateRestorePower(dev);
  const buffer = computeRestoreBufferKw(power);
  return { power, buffer, needed: power + buffer };
}
