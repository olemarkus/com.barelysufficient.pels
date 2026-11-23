import type { DeferredReleaseIntent } from '../../packages/planner-types/src/deferredDecoration';

/** The decided idle-task posture, distinct from a capacity-driven shed. */
export type ShedReleasePosture =
  | { kind: 'binary_off' }
  | { kind: 'target_value'; target: number }
  | { kind: 'step'; stepId: string };

/** A resolved release decision. Execution never reads the policy that selected it. */
export type PlannedReleaseIntent =
  | Exclude<DeferredReleaseIntent, { kind: 'shed_release' }>
  | { kind: 'shed_release'; posture: ShedReleasePosture };
