import type { ThermalDirection } from '../../packages/contracts/src/types';

/**
 * The one ordering of setpoints in PELS.
 *
 * Up is more demand for a heater and less for a unit that is cooling, so a bare
 * `>` between two temperatures is a heating assumption. Everything that orders
 * two temperatures goes through here, in this module, before the planner — the
 * planner is handed setpoints and facts, never a direction.
 */

/**
 * How far `valueC` falls short of `targetC` on the device's demand axis: how
 * much more work the device would do at `targetC` than at `valueC`. Negative
 * when `valueC` already asks for more.
 */
export function demandShortfallC(direction: ThermalDirection, valueC: number, targetC: number): number {
  return direction === 'cooling' ? valueC - targetC : targetC - valueC;
}

/** Whether moving a device's setpoint from `fromC` to `toC` makes it work harder. */
export function setpointAddsDemand(direction: ThermalDirection, fromC: number, toC: number): boolean {
  return demandShortfallC(direction, fromC, toC) > 0;
}

/** Of two setpoints, the one that asks for more work. */
export function moreDemandingSetpoint(direction: ThermalDirection, aC: number, bC: number): number {
  return setpointAddsDemand(direction, aC, bC) ? bC : aC;
}

/** `fromC` moved `deltaC` towards more work: up for a heater, down for a cooling unit. */
export function towardDemand(direction: ThermalDirection, fromC: number, deltaC: number): number {
  return direction === 'cooling' ? fromC - deltaC : fromC + deltaC;
}
