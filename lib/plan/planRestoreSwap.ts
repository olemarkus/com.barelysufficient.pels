import type { DevicePlanDevice } from './planTypes';
import { resolveCandidatePower } from './planCandidatePower';
import { isSteppedLoadDevice } from './planSteppedLoad';
import { getSteppedLoadRestoreStep } from '../utils/deviceControlProfiles';

export function buildSwapCandidates(params: {
  dev: DevicePlanDevice;
  onDevices: DevicePlanDevice[];
  swappedOutFor: ReadonlyMap<string, string>;
  availableHeadroom: number;
  needed: number;
  restoredThisCycle: Set<string>;
}): {
  ready: boolean;
  toShed: DevicePlanDevice[];
  shedPowerByDeviceId: Map<string, number>;
  potentialHeadroom: number;
  shedNames: string;
  shedPower: string;
  availableHeadroom: number;
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
  const targetPriority = dev.priority ?? 100;
  let potentialHeadroom = availableHeadroom;
  const toShed: DevicePlanDevice[] = [];
  const shedPowerByDeviceId = new Map<string, number>();
  for (const onDev of onDevices) {
    if ((onDev.priority ?? 100) <= targetPriority) break;
    const onDevPower = getSwapCandidatePower(onDev, swappedOutFor, restoredThisCycle);
    if (onDevPower === null) continue;
    toShed.push(onDev);
    shedPowerByDeviceId.set(onDev.id, onDevPower);
    potentialHeadroom += onDevPower;
    if (potentialHeadroom >= needed) break;
  }
  if (potentialHeadroom < needed || toShed.length === 0) {
    return {
      ready: false,
      toShed,
      shedPowerByDeviceId,
      potentialHeadroom,
      shedNames: '',
      shedPower: '0.00',
      availableHeadroom,
      reason: `insufficient headroom (need ${needed.toFixed(2)}kW, headroom ${availableHeadroom.toFixed(2)}kW)`,
    };
  }
  const shedNames = toShed.map((d) => d.name).join(', ');
  const shedPower = Array.from(shedPowerByDeviceId.values()).reduce((sum, power) => sum + power, 0).toFixed(2);
  return {
    ready: true,
    toShed,
    shedPowerByDeviceId,
    potentialHeadroom,
    shedNames,
    shedPower,
    availableHeadroom,
    reason: '',
  };
}

function getSwapCandidatePower(
  onDev: DevicePlanDevice,
  swappedOutFor: ReadonlyMap<string, string>,
  restoredThisCycle: Set<string>,
): number | null {
  if (onDev.plannedState === 'shed') return null;
  if (swappedOutFor.has(onDev.id)) return null;
  if (restoredThisCycle.has(onDev.id)) return null;
  const onDevPower = resolveCandidatePower(onDev);
  if (onDevPower === null || onDevPower <= 0) return null;
  return onDevPower;
}

export function buildInsufficientHeadroomUpdate(
  needed: number,
  availableHeadroom: number,
): Partial<DevicePlanDevice> {
  const reason = `insufficient headroom (need ${needed.toFixed(2)}kW, headroom ${availableHeadroom.toFixed(2)}kW)`;
  return { plannedState: 'shed', reason };
}

export function computeRestoreBufferKw(devPower: number): number {
  const boundedPower = Math.max(0, devPower);
  const scaled = boundedPower * 0.1 + 0.1;
  return Math.max(0.2, Math.min(0.6, scaled));
}

export function estimateRestorePower(dev: DevicePlanDevice): number {
  if (typeof dev.planningPowerKw === 'number' && dev.planningPowerKw > 0) return dev.planningPowerKw;
  // For stepped devices at zero planning power (off-step or temperature-shed),
  // use the lowest non-zero step as the conservative re-entry estimate.
  if (isSteppedLoadDevice(dev) && dev.steppedLoadProfile) {
    const restoreStep = getSteppedLoadRestoreStep(dev.steppedLoadProfile);
    if (restoreStep && restoreStep.planningPowerW > 0) return restoreStep.planningPowerW / 1000;
  }
  if (typeof dev.expectedPowerKw === 'number') return dev.expectedPowerKw;
  if (typeof dev.measuredPowerKw === 'number' && dev.measuredPowerKw > 0) return dev.measuredPowerKw;
  return dev.powerKw ?? 1;
}

export function computeBaseRestoreNeed(dev: DevicePlanDevice): { power: number; buffer: number; needed: number } {
  const power = estimateRestorePower(dev);
  const buffer = computeRestoreBufferKw(power);
  return { power, buffer, needed: power + buffer };
}
