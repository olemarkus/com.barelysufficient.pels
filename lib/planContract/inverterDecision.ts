import type { InverterObservation } from '../../packages/contracts/src/inverterControl';

/**
 * The planner's production decision. A limit captures the reports it used only
 * for stale-command preflight; that capture is never published as live truth.
 */
export type InverterDecision =
  | { kind: 'limit'; deviceId: string; limitW: number; observation: InverterObservation }
  | { kind: 'release'; deviceId: string };
