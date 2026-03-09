import type { PlanEngineState } from './planState';
import {
  applyActivationPenalty,
  syncActivationPenaltyState,
} from './planActivationBackoff';
import type { DeviceDiagnosticsRecorder } from '../diagnostics/deviceDiagnosticsService';
import {
  emitActivationTransitions,
  type HeadroomCardCooldownSource,
  type HeadroomCardDeviceLike,
  resolveHeadroomCardCooldown,
  resolveObservedHeadroomDeviceKw,
  syncHeadroomCardState,
} from './planHeadroomState';

export type { HeadroomCardCooldownSource, HeadroomCardDeviceLike };
export {
  resolveHeadroomCardCooldown,
  resolveObservedHeadroomDeviceKw,
  syncHeadroomCardState,
  syncHeadroomCardTrackedUsage,
} from './planHeadroomState';

export type HeadroomForDeviceDecision = {
  allowed: boolean;
  cooldownSource: HeadroomCardCooldownSource | null;
  cooldownRemainingSec: number | null;
  observedKw: number;
  calculatedHeadroomForDeviceKw: number;
  penaltyLevel: number;
  requiredKwWithPenalty: number;
  stickRemainingSec: number | null;
  clearRemainingSec: number | null;
  dropFromKw: number | null;
  dropToKw: number | null;
  stateChanged: boolean;
};

const isFiniteNumber = (value: unknown): value is number => (
  typeof value === 'number' && Number.isFinite(value)
);

export const evaluateHeadroomForDevice = (params: {
  state: PlanEngineState;
  devices: HeadroomCardDeviceLike[];
  deviceId: string;
  device?: HeadroomCardDeviceLike;
  headroom: number;
  requiredKw: number;
  nowTs?: number;
  cleanupMissingDevices?: boolean;
  diagnostics?: DeviceDiagnosticsRecorder;
}): HeadroomForDeviceDecision | null => {
  const {
    state,
    devices,
    deviceId,
    device: providedDevice,
    headroom,
    requiredKw,
    cleanupMissingDevices = false,
    diagnostics,
  } = params;
  const nowTs = params.nowTs ?? Date.now();
  const stateChanged = syncHeadroomCardState({
    state,
    devices,
    nowTs,
    cleanupMissingDevices,
    diagnostics,
  });
  const device = providedDevice ?? devices.find((entry) => entry.id === deviceId);
  if (!device) return null;
  const penaltyInfo = syncActivationPenaltyState({
    state,
    deviceId,
    nowTs,
    observation: device,
  });
  emitActivationTransitions(diagnostics, device.name, penaltyInfo.transitions);

  const observedKw = resolveObservedHeadroomDeviceKw(device);
  const calculatedHeadroomForDeviceKw = headroom + observedKw;
  const penalty = applyActivationPenalty({
    baseRequiredKw: requiredKw,
    penaltyLevel: penaltyInfo.penaltyLevel,
  });
  const cooldown = resolveHeadroomCardCooldown({
    state,
    deviceId,
    nowTs,
  });
  return {
    allowed: cooldown === null && calculatedHeadroomForDeviceKw >= penalty.requiredKwWithPenalty,
    cooldownSource: cooldown?.source ?? null,
    cooldownRemainingSec: cooldown?.remainingSec ?? null,
    observedKw,
    calculatedHeadroomForDeviceKw,
    penaltyLevel: penaltyInfo.penaltyLevel,
    requiredKwWithPenalty: penalty.requiredKwWithPenalty,
    stickRemainingSec: penaltyInfo.stickRemainingSec,
    clearRemainingSec: penaltyInfo.clearRemainingSec,
    dropFromKw: cooldown?.dropFromKw ?? null,
    dropToKw: cooldown?.dropToKw ?? null,
    stateChanged: stateChanged || penaltyInfo.stateChanged,
  };
};

export const formatHeadroomCooldownReason = (params: {
  source: HeadroomCardCooldownSource;
  remainingSec: number;
  dropFromKw?: number | null;
  dropToKw?: number | null;
}): string => {
  const { source, remainingSec, dropFromKw, dropToKw } = params;
  if (source === 'step_down') {
    const fromText = isFiniteNumber(dropFromKw) ? dropFromKw.toFixed(2) : 'unknown';
    const toText = isFiniteNumber(dropToKw) ? dropToKw.toFixed(2) : 'unknown';
    return `headroom cooldown (${remainingSec}s remaining; usage ${fromText} -> ${toText}kW)`;
  }
  if (source === 'pels_shed') {
    return `headroom cooldown (${remainingSec}s remaining; recent PELS shed)`;
  }
  return `headroom cooldown (${remainingSec}s remaining; recent PELS restore)`;
};
