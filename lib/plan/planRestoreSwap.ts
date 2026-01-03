import type { DevicePlanDevice } from './planTypes';
import type { PlanEngineState } from './planState';

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
  let toShed: DevicePlanDevice[] = [];
  for (const onDev of onDevices) {
    if ((onDev.priority ?? 100) <= (dev.priority ?? 100)) break;
    if (onDev.plannedState === 'shed') continue;
    if (state.swappedOutFor[onDev.id]) continue;
    if (restoredThisCycle.has(onDev.id)) continue;
    const onDevPower = onDev.powerKw && onDev.powerKw > 0 ? onDev.powerKw : 1;
    toShed = [...toShed, onDev];
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
  const shedPower = toShed.reduce((sum, d) => sum + (d.powerKw ?? 1), 0).toFixed(2);
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

export function estimateRestorePower(dev: DevicePlanDevice): number {
  if (typeof dev.expectedPowerKw === 'number') return dev.expectedPowerKw;
  if (typeof dev.measuredPowerKw === 'number' && dev.measuredPowerKw > 0) return dev.measuredPowerKw;
  return dev.powerKw ?? 1;
}
