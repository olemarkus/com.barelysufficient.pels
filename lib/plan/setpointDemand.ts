import type { ThermalDirection } from '../../packages/contracts/src/types';

/**
 * Whether moving a device's setpoint from `from` to `to` makes it work harder.
 *
 * The one ordering of setpoints the planner may use. Up is more demand for a
 * heater and less for a unit that is cooling, so a bare `>` between two targets
 * is a heating assumption: it reads a cooling unit's limit as a resume and its
 * resume as a limit. The reverse question, "does this move release demand", is
 * the same call with the arguments swapped. An unchanged setpoint does neither.
 */
export function setpointAddsDemand(direction: ThermalDirection, from: number, to: number): boolean {
  return direction === 'cooling' ? to < from : to > from;
}
