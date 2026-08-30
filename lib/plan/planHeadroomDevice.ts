import type { PlanEngineState } from './planState';
import {
  applyActivationPenalty,
  syncActivationPenaltyState,
} from './admission';
import type { DeviceDiagnosticsRecorder } from '../diagnostics/deviceDiagnosticsService';
import {
  emitActivationTransitions,
  resolveHeadroomCardCooldown,
  syncHeadroomCardState,
} from './planHeadroomState';
import type {
  HeadroomCardCooldownSource,
  HeadroomCardDeviceLike,
} from './planHeadroomSupport';

export type {
  HeadroomCardCooldownSource,
  HeadroomCardDeviceLike,
  HeadroomUsageObservation,
} from './planHeadroomSupport';
export {
  syncHeadroomCardState,
  syncHeadroomUsageObservation,
} from './planHeadroomState';

/**
 * The device's current draw, for headroom-for-device math.
 *
 * One rung of its own: `available === false` → 0. Homey reports that for a
 * device that is offline, unreachable, or gone from the mesh, and the Flow card
 * is asking permission to ADD load — crediting a device that cannot be consuming
 * anything would let activations through against capacity that is not free.
 * Mirrors `isActivelyDrawing` in `lib/observer/observedPower.ts`.
 *
 * Everything else is `currentDrawKw`, trusted as-is. This used to re-derive the
 * draw through a measured → observed-off → highest-configured ladder, a FOURTH
 * copy of the producer's own resolution; it is gone with the other three.
 *
 * Its last rung credited an unmetered running device its configured load. That
 * rung is not replaced, and does not need to be: every managed device is metered
 * (verified across a 124-device fleet — all 11 devices carrying a `settings.load`
 * also expose `measure_power` and `meter_power`), so the meter answers. A device
 * that reports nothing credits nothing, which is what this card's own
 * conservative rule asks for.
 *
 * Observation age is intentionally NOT a short-circuit. Many Homey drivers only
 * republish per-capability `lastUpdated` on value change, so a thermostat steady
 * at setpoint falls silent for hours while still on and drawing exactly what it
 * last reported. Returning 0 for that case under-credited known load and blocked
 * legitimate activations. (Nothing ages an observation out any more; the rule is
 * kept stated here because it is what makes the plain read below correct.)
 */
const resolveObservedHeadroomDeviceKw = (
  device: HeadroomCardDeviceLike,
): number => {
  if (device.available === false) return 0;
  return device.currentDrawKw;
};

export type HeadroomForDeviceDecision = {
  allowed: boolean;
  cooldownSource: HeadroomCardCooldownSource | null;
  cooldownRemainingSec: number | null;
  observedKw: number;
  calculatedHeadroomForDeviceKw: number;
  penaltyLevel: number;
  requiredKwWithPenalty: number;
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
    clearRemainingSec: penaltyInfo.clearRemainingSec,
    dropFromKw: cooldown?.dropFromKw ?? null,
    dropToKw: cooldown?.dropToKw ?? null,
    stateChanged: stateChanged || penaltyInfo.stateChanged,
  };
};
