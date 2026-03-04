import type { DevicePlanDevice } from './planTypes';
import type { PlanEngineState } from './planState';

function getSwapCandidatePowerKw(device: DevicePlanDevice): number {
  if (typeof device.measuredPowerKw === 'number' && Number.isFinite(device.measuredPowerKw)) {
    return device.measuredPowerKw > 0 ? device.measuredPowerKw : 0;
  }
  if (typeof device.expectedPowerKw === 'number' && device.expectedPowerKw > 0) {
    return device.expectedPowerKw;
  }
  if (typeof device.powerKw === 'number' && device.powerKw > 0) {
    return device.powerKw;
  }
  return 1;
}

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
  for (const onDev of onDevices) {
    if ((onDev.priority ?? 100) <= (dev.priority ?? 100)) break;
    if (onDev.plannedState === 'shed') continue;
    if (state.swappedOutFor[onDev.id]) continue;
    if (restoredThisCycle.has(onDev.id)) continue;
    const onDevPower = getSwapCandidatePowerKw(onDev);
    if (onDevPower <= 0) continue;
    toShed.push(onDev);
    potentialHeadroom += onDevPower;
    if (potentialHeadroom >= needed) break;
  }
  if (potentialHeadroom < needed || toShed.length === 0) {
    return {
      ready: false,
      toShed,
      potentialHeadroom,
      shedNames: '',
      shedPower: '0.00',
      availableHeadroom,
      reason: `insufficient headroom (need ${needed.toFixed(2)}kW, headroom ${availableHeadroom.toFixed(2)}kW)`,
    };
  }
  const shedNames = toShed.map((d) => d.name).join(', ');
  const shedPower = toShed.reduce((sum, d) => sum + getSwapCandidatePowerKw(d), 0).toFixed(2);
  return {
    ready: true,
    toShed,
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
