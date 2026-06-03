export { planDeferredObjectiveHorizon } from './horizonPlanner';
export {
  buildDeferredObjectiveDiagnostics,
  emitDeferredObjectiveDiagnostics,
} from './diagnosticsBridge';
export { createDeferredObjectiveStatusBus } from './statusBus';
export { createDeferredObjectivePlanRevisionBus } from './planRevisionBus';
export type {
  DeferredObjectivePlanRevisionBus,
  DeferredObjectivePlanRevisionEvent,
  DeferredObjectivePlanRevisionWrittenEvent,
} from './planRevisionBus';
export { createDeferredObjectiveEndedBus } from './endedEventBus';
export type {
  DeferredObjectiveEndedBus,
  DeferredObjectiveEndedEvent,
} from './endedEventBus';
export { createDeferredObjectiveHoursRemainingBus } from './hoursRemainingBus';
export type {
  DeferredObjectiveHoursRemainingBus,
  DeferredObjectiveHoursRemainingEvent,
} from './hoursRemainingBus';
export { createDeferredObjectiveHoursRemainingTracker } from './hoursRemainingCrossings';
export type { DeferredObjectiveHoursRemainingTracker } from './hoursRemainingCrossings';
export { emitDeferredObjectiveStatusTransitions } from './statusTransitions';
export type {
  DeferredObjectiveStatusBus,
  DeferredObjectiveStatusSnapshot,
} from './statusBus';
export {
  DeferredObjectivePlanHistoryRecorder,
  type DeferredObjectiveBackfillConfig,
} from './planHistory';
export { normalizeDeferredObjectivePlanHistory } from './planHistorySettings';
export { DeferredObjectiveActivePlanRecorder } from './activePlanRecorder';
export {
  applyDeferredObjectiveChange,
  type DeferredObjectiveChangeInput,
} from './objectiveChange';
export {
  upsertObjectiveForDevice,
  clearObjectiveForDevice,
  type DeferredObjectiveDeviceWriteDeps,
  type ObjectiveWriteOutcome,
} from './objectiveWrite';
export {
  migrateBlobToPerKeyIfNeeded,
  readAllObjectives,
  readObjectiveForDevice,
  writeObjectiveForDevice,
} from './objectiveStore';
export { normalizeDeferredObjectiveActivePlans } from './activePlanSettings';
export { formatDeadlineLocalTime, resolveDeferredObjectiveDeadline } from './deadline';
export { buildDeferredObjectivePolicyHorizon } from './policyHorizon';
export { previewDeferredObjectivePlan } from './planPreview';
export type {
  DeferredObjectivePlanPreviewCandidate,
} from '../../../packages/contracts/src/deferredObjectivePlanPreview';
export {
  ConcurrentEligibleTaskTracker,
  ELIGIBILITY_ABANDON_GRACE_MS,
} from './concurrentEligibleTasks';
export {
  createEmptyDeferredObjectiveSettings,
  normalizeDeferredObjectiveSettings,
  normalizeDeferredObjectiveSettingsEntry,
} from './settings';
export type {
  DeferredObjectiveDiagnostic,
  DeferredObjectiveDiagnosticReasonCode,
} from './diagnosticsBridge';
export type { DeferredObjectiveDeadlineResolution } from './deadline';
export type {
  DeferredObjectivePolicyHorizonResult,
  DeferredObjectivePolicyHorizonUnavailableReason,
} from './policyHorizon';
export type {
  DeferredObjectiveRescueMode,
  DeferredObjectiveRescuePermissions,
  DeferredObjectiveSettingsEntry,
  DeferredObjectiveSettingsKind,
  DeferredObjectiveSettingsV1,
} from './settings';
export type {
  DeferredObjective,
  DeferredObjectiveCurrentBucketPlan,
  DeferredObjectiveEnforcement,
  DeferredObjectiveHorizonBucket,
  DeferredObjectiveHorizonInput,
  DeferredObjectiveHorizonPlan,
  DeferredObjectiveHorizonStatus,
  DeferredObjectiveHorizonStatusDetail,
  DeferredObjectiveKind,
  DeferredObjectivePlannedBucket,
  DeferredObjectiveStep,
} from './types';
// Smart-task controller: the input-decoration stage the app wiring constructs
// and injects into the planner as `decorateDeferredObjectives`. The planner
// consumes the flat `DeferredDecorationBundle` it produces (see
// @pels/planner-types) and imports none of this subsystem. The admission
// appliers it owns stay internal (reached via ./admission directly).
export { DeferredObjectiveDecorationController } from './decorationController';
