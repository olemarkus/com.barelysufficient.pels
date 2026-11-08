import type { DeviceReason } from '../../../packages/shared-domain/src/planReasonSemantics';
import type { PhaseFootprint, PhaseName } from '../../../packages/planner-types/src/phaseFootprint';

/** One decision the pass took. Its relief is credited against the phases while it is undelivered. */
export type PhaseShedDecision = {
  atMs: number;
  reliefKw: number;
  drawAtDecisionKw: number;
  footprint: PhaseFootprint;
  reason: DeviceReason;
  stepId?: string;
  setpointW?: number;
};

/** What the pass remembers between builds. */
export type PhaseShedState = {
  readonly decisions: ReadonlyMap<string, PhaseShedDecision>;
  /** The sample the pass last spent on: a rebuild on the same sample holds and adds nothing. */
  readonly spentOnSampleAtMs: number | null;
  readonly unrelievedPhase: PhaseName | null;
};

export const NO_PHASE_SHED_STATE: PhaseShedState = Object.freeze({
  decisions: new Map<string, PhaseShedDecision>(),
  spentOnSampleAtMs: null,
  unrelievedPhase: null,
});
