import type { DevicePlanDevice } from './planTypes';
import type { PlanEngineState } from './planState';
import { resolveCandidatePower } from './planCandidatePower';

export function buildSwapCandidates(params: {
  dev: DevicePlanDevice;
  onDevices: DevicePlanDevice[];
  state: PlanEngineState;
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
    state,
    availableHeadroom,
    needed,
    restoredThisCycle,
  } = params;
  let potentialHeadroom = availableHeadroom;
  const toShed: DevicePlanDevice[] = [];
  const shedPowerByDeviceId = new Map<string, number>();
  for (const onDev of onDevices) {
    if ((onDev.priority ?? 100) <= (dev.priority ?? 100)) break;
    if (onDev.plannedState === 'shed') continue;
    if (state.swappedOutFor[onDev.id]) continue;
    if (restoredThisCycle.has(onDev.id)) continue;
    const onDevPower = resolveCandidatePower(onDev);
    if (onDevPower === null) continue;
    if (onDevPower <= 0) continue;
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
  if (typeof dev.expectedPowerKw === 'number') return dev.expectedPowerKw;
  if (typeof dev.measuredPowerKw === 'number' && dev.measuredPowerKw > 0) return dev.measuredPowerKw;
  return dev.powerKw ?? 1;
}
