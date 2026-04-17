import type { PlanEngineState } from './planState';
import {
  applyActivationPenalty,
  syncActivationPenaltyState,
} from './planActivationBackoff';
import type { DeviceDiagnosticsRecorder } from '../diagnostics/deviceDiagnosticsService';
import {
  emitActivationTransitions,
  resolveHeadroomCardCooldown,
  syncHeadroomCardState,
} from './planHeadroomState';
import {
  resolveObservedHeadroomDeviceKw,
  type HeadroomCardCooldownSource,
  type HeadroomCardDeviceLike,
  type HeadroomDeviceKwSource,
} from './planHeadroomSupport';

export type {
  HeadroomCardCooldownSource,
  HeadroomCardDeviceLike,
  HeadroomDeviceKwSource,
} from './planHeadroomSupport';
export {
  resolveHeadroomCardCooldown,
  syncHeadroomCardState,
  syncHeadroomCardTrackedUsage,
} from './planHeadroomState';
export { resolveObservedHeadroomDeviceKw } from './planHeadroomSupport';

export type HeadroomForDeviceDecision = {
  allowed: boolean;
  cooldownSource: HeadroomCardCooldownSource | null;
  cooldownRemainingSec: number | null;
  observedKw: number;
  observedKwSource: HeadroomDeviceKwSource;
  calculatedHeadroomForDeviceKw: number;
  penaltyLevel: number;
  requiredKwWithPenalty: number;
  stickRemainingSec: number | null;
  clearRemainingSec: number | null;
  dropFromKw: number | null;
  dropToKw: number | null;
  stateChanged: boolean;
};

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

  const { kw: observedKw, source: observedKwSource } = resolveObservedHeadroomDeviceKw(device);
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
    observedKwSource,
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
