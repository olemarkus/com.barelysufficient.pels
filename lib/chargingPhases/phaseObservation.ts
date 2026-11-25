import type { ChargingPhaseCount } from '../../packages/contracts/src/chargingPhases';
import type { ChargingPhaseEnvelope } from '../../packages/planner-types/src/chargingPhases';
import type { ChargingPhaseDevice } from '../ports/chargingPhases';
import { CHARGING_PHASE_POWER_NOISE_W } from '../ports/chargingPhases';

/** Below this floor a phase can carry standby/noise, not evidence of vehicle charging. */
export const CHARGING_PHASE_DRAWING_W = CHARGING_PHASE_POWER_NOISE_W;

/** Matching power must belong to the command, not a retained pre-command reading. */
export function confirmsChargingPhases(
  device: ChargingPhaseDevice, phases: ChargingPhaseCount, issuedAtMs: number,
): boolean {
  if (phases === 3) return device.powers.slice(1).some((power) => (
    power.watts > CHARGING_PHASE_DRAWING_W && power.observedAtMs >= issuedAtMs
  ));
  const [l1, l2, l3] = device.powers;
  return l1.watts > CHARGING_PHASE_DRAWING_W
    && l2.watts <= CHARGING_PHASE_DRAWING_W
    && l3.watts <= CHARGING_PHASE_DRAWING_W
    && device.totalPower.observedAtMs >= issuedAtMs
    && Math.abs(device.totalPower.watts - l1.watts - l2.watts - l3.watts) <= CHARGING_PHASE_DRAWING_W;
}

function fitsMeasuredPhaseFloor(device: ChargingPhaseDevice): boolean | undefined {
  const [l1, l2, l3] = device.phaseVoltagesV;
  if (l1 === null) return undefined;
  const [a, b, c] = device.powers;
  const l1FloorW = l1 * device.minimumCurrentA;
  if (device.planningPhases === 1) {
    return Math.max(a.watts, device.totalPower.watts) <= l1FloorW + CHARGING_PHASE_DRAWING_W;
  }
  if (l2 === null || l3 === null) return undefined;
  const l2FloorW = l2 * device.minimumCurrentA;
  const l3FloorW = l3 * device.minimumCurrentA;
  // A lightly loaded phase must not hide an overloaded one. The readings
  // share one noise allowance, as they do at the nominal floor.
  const excessW = Math.max(0, a.watts - l1FloorW) + Math.max(0, b.watts - l2FloorW) + Math.max(0, c.watts - l3FloorW);
  return excessW <= CHARGING_PHASE_DRAWING_W
    && device.totalPower.watts <= l1FloorW + l2FloorW + l3FloorW + CHARGING_PHASE_DRAWING_W;
}

/** Independent measured load must already fit the current geometry's minimum current. */
export function isChargingPhaseFloor(
  device: ChargingPhaseDevice, envelopes: readonly ChargingPhaseEnvelope[],
): boolean {
  if (device.currentLimitA > device.minimumCurrentA) return false;
  const envelope = envelopes.find((entry) => entry.phases === device.planningPhases);
  const floor = envelope?.profile.steps.find((step) => step.planningCurrentA === device.minimumCurrentA);
  if (!floor) return false;
  const [a, b, c] = device.powers;
  if (Math.abs(device.totalPower.watts - a.watts - b.watts - c.watts) > CHARGING_PHASE_DRAWING_W) return false;
  return fitsMeasuredPhaseFloor(device) ?? (device.totalPower.watts <= floor.planningPowerW + CHARGING_PHASE_DRAWING_W);
}
