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
import { getHighestKnownPowerKw, getMeasuredDrawKw } from '../observer/observedPower';
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
  resolveHeadroomCardCooldown,
  syncHeadroomCardState,
  syncHeadroomUsageObservation,
} from './planHeadroomState';

/**
 * Conservative read of a device's current draw for headroom-for-device math.
 * The Flow card is asking permission to *add* load, so we never synthesize
 * draw the device hasn't proven it consumes:
 *
 *  - Device unavailable → 0. Homey reports `available === false` for devices
 *    that are offline / unreachable / removed from the mesh. Crediting their
 *    declared load would let activations through against capacity that the
 *    device cannot actually be consuming. Mirrors `isActivelyDrawing` in
 *    `lib/observer/observedPower.ts`.
 *  - Measured draw present → that value (including 0 — a real zero-measurement
 *    is authoritative).
 *  - Observed-off → 0.
 *  - Otherwise (running, with or without a fresh measurement) → highest known
 *    configured demand (expected / planning / configured `powerKw`) so
 *    non-metered relays still credit their declared load. If none of those
 *    are configured either, fall back to 0 — we explicitly avoid Observer's
 *    generic 1.0 kW / EV 1.38 kW fallback because that would overstate
 *    `headroom + observedKw` and let activations through that should be
 *    blocked.
 *
 * Observation staleness is intentionally NOT a short-circuit here. Many Homey
 * drivers only republish per-capability `lastUpdated` on value change, so a
 * thermostat steady at setpoint can age out of `STALE_DEVICE_OBSERVATION_MS`
 * while still being on and drawing exactly its configured load. Returning 0
 * for that case under-credited known load and blocked legitimate activations.
 * The `available === false`, `currentOn === false`, and zero-measured branches
 * above already cover the conservative cases.
 */
const resolveObservedHeadroomDeviceKw = (
  device: HeadroomCardDeviceLike,
): number => {
  if (device.available === false) return 0;
  const measured = getMeasuredDrawKw(device);
  if (measured !== null) return measured;
  if (device.currentOn === false) return 0;
  return getHighestKnownPowerKw(device)?.kw ?? 0;
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
