import type { PlanEngineState } from './planState';
import {
  applyActivationPenalty,
  resolveActivationRestoreBlock,
  syncActivationPenaltyState,
} from './admission';
import type { DeviceDiagnosticsRecorder } from '../diagnostics/deviceDiagnosticsService';
import {
  emitActivationTransition,
  resolveHeadroomCardCooldown,
  syncHeadroomCardSnapshot,
} from './planHeadroomState';
import type {
  HeadroomCardCooldownSource,
  HeadroomCardDeviceLike,
} from './planHeadroomSupport';

export type {
  HeadroomCardCooldownSource,
  HeadroomCardDeviceLike,
} from './planHeadroomSupport';
export {
  syncHeadroomCardSnapshot,
  syncHeadroomCardState,
  syncHeadroomUsageObservation,
} from './planHeadroomState';

/**
 * The Flow headroom card's question: is there `requiredKw` of available power
 * for `device`, given `headroom` and the current snapshot of every device
 * (`devices`, which the card stamps with `withHeadroomCurrentOn` so the
 * activation reads see each one's on/off truth). Built once by the card and
 * carried unchanged through the app context and the plan service. `device` is
 * also an element of `devices`: the card already found it, and carrying it
 * beats making the engine search and answer null when it is not there.
 */
export type HeadroomCardQuery = {
  devices: HeadroomCardDeviceLike[];
  device: HeadroomCardDeviceLike;
  headroom: number;
  requiredKw: number;
};

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

export const evaluateHeadroomForDevice = (
  state: PlanEngineState,
  query: HeadroomCardQuery,
  nowTs: number,
  diagnostics: DeviceDiagnosticsRecorder | undefined,
): HeadroomForDeviceDecision => {
  const { devices, device, headroom, requiredKw } = query;
  const stateChanged = syncHeadroomCardSnapshot(state, devices, nowTs, undefined, diagnostics);
  const penaltyInfo = syncActivationPenaltyState(state, device.id, nowTs, device);
  emitActivationTransition(diagnostics, device.name, penaltyInfo.transition);

  const observedKw = resolveObservedHeadroomDeviceKw(device);
  const calculatedHeadroomForDeviceKw = headroom + observedKw;
  const penalty = applyActivationPenalty(requiredKw, penaltyInfo.penaltyLevel);
  const cooldown = resolveHeadroomCardCooldown(state, device.id, nowTs);
  // For the card's log line only: seconds until the setback block lifts, 0 once
  // it has while the penalty level still stands, null with no penalty at all.
  const block = resolveActivationRestoreBlock(state, device.id, nowTs);
  let clearRemainingSec: number | null = null;
  if (block !== null) clearRemainingSec = Math.ceil(block.remainingMs / 1000);
  else if (penaltyInfo.penaltyLevel > 0) clearRemainingSec = 0;
  return {
    allowed: cooldown === null && calculatedHeadroomForDeviceKw >= penalty.requiredKwWithPenalty,
    cooldownSource: cooldown?.source ?? null,
    cooldownRemainingSec: cooldown?.remainingSec ?? null,
    observedKw,
    calculatedHeadroomForDeviceKw,
    penaltyLevel: penaltyInfo.penaltyLevel,
    requiredKwWithPenalty: penalty.requiredKwWithPenalty,
    clearRemainingSec,
    dropFromKw: cooldown?.dropFromKw ?? null,
    dropToKw: cooldown?.dropToKw ?? null,
    stateChanged: stateChanged || penaltyInfo.stateChanged,
  };
};
