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

/** Independent measured load must already fit the current geometry's minimum current. */
export function isChargingPhaseFloor(
  device: ChargingPhaseDevice, envelopes: readonly ChargingPhaseEnvelope[],
): boolean {
  if (device.currentLimitA > device.minimumCurrentA) return false;
  const envelope = envelopes.find((entry) => entry.phases === device.planningPhases);
  const floor = envelope?.profile.steps.find((step) => step.planningCurrentA === device.minimumCurrentA);
  if (!floor) return false;
  const [a, b, c] = device.powers;
  return device.totalPower.watts <= floor.planningPowerW + CHARGING_PHASE_DRAWING_W
    && Math.abs(device.totalPower.watts - a.watts - b.watts - c.watts) <= CHARGING_PHASE_DRAWING_W;
}
