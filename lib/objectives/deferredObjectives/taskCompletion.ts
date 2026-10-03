import type { StallEvidence } from '../../../packages/contracts/src/idleClassification';
import type { ObjectiveProgressDirection } from '../types';
import { stallEvidenceCoversTarget } from '../stallEvidence';

export type TaskCompletion =
  | { kind: 'unmet' }
  | { kind: 'target_reached' }
  | { kind: 'accepted_near_target' };

/** Known progress and eligible observer evidence, resolved by the input owner. */
export type TaskCompletionInput = {
  currentValue: number;
  requestedTarget: number;
  direction: ObjectiveProgressDirection;
  thermalEvidence: { kind: 'none' } | { kind: 'accepted'; evidence: StallEvidence };
};

/** Completion follows the requested obligation, independent of forecasting and device type. */
export const resolveTaskCompletion = (input: TaskCompletionInput): TaskCompletion => {
  const reached = input.direction === 'increasing'
    ? input.currentValue >= input.requestedTarget
    : input.currentValue <= input.requestedTarget;
  if (reached) return { kind: 'target_reached' };
  if (input.thermalEvidence.kind === 'accepted'
    && stallEvidenceCoversTarget(input.thermalEvidence.evidence, input.requestedTarget, input.direction)) {
    return { kind: 'accepted_near_target' };
  }
  return { kind: 'unmet' };
};
