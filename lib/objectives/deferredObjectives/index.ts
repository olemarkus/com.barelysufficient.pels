export { planDeferredObjectiveHorizon } from './horizonPlanner';
export {
  buildDeferredObjectiveDiagnostics,
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
export {
  emitDeferredObjectiveLifecycleTransitions,
  emitDeferredObjectiveStatusTransitions,
} from './statusTransitions';
export type {
  DeferredObjectiveStatusBus,
} from './statusBus';
export {
  DeferredObjectivePlanHistoryRecorder,
  type DeferredObjectiveBackfillConfig,
} from './planHistory';
export {
  normalizeDeferredObjectivePlanHistory,
  parseDeferredObjectivePlanHistory,
} from './planHistorySettings';
export { DeferredObjectiveActivePlanRecorder } from './activePlanRecorder';
export {
  applyDeferredObjectiveChange,
} from './objectiveChange';
export {
  upsertObjectiveForDevice,
  clearObjectiveForDevice,
  type DeferredObjectiveDeviceWriteDeps,
  type ObjectiveWriteOutcome,
} from './objectiveWrite';
export {
  createTrustedDeferredObjectiveSettingsReader,
  hasOpenDeferredObjective,
  migrateBlobToPerKeyIfNeeded,
  objectiveKeyListIsTrustworthy,
  readDeferredObjectiveRoster,
  readAllObjectives,
  readObjectiveForDevice,
  writeObjectiveForDevice,
} from './objectiveStore';
export { normalizeDeferredObjectiveActivePlans } from './activePlanSettings';
export { formatDeadlineLocalTime, resolveDeferredObjectiveDeadline } from './deadline';
export {
  buildValidSmartTaskCandidate,
  mapSmartTaskAppReason,
  parseSmartTaskCandidateRequest,
  resolveSmartTaskRequestDeadline,
  resolveSmartTaskWriteDeadline,
  type SmartTaskWriteOrigin,
} from './smartTaskCandidateRequest';
export { buildDeferredObjectivePolicyHorizon } from './policyHorizon';
export {
  buildUnavailableDeferredObjectivePlanEstimate,
  previewDeferredObjectivePlan,
} from './planPreview';
export type {
  DeferredObjectivePlanPreviewCandidate,
} from '../../../packages/contracts/src/deferredObjectivePlanPreview';
export {
  ConcurrentEligibleTaskTracker,
  ELIGIBILITY_ABANDON_GRACE_MS,
} from './concurrentEligibleTasks';
export { PriorityAllocationTracker } from './priorityAllocation';
export {
  createEmptyDeferredObjectiveSettings,
  normalizeDeferredObjectiveSettings,
  normalizeDeferredObjectiveSettingsEntry,
} from './settings';
export type {
  BuildPriceHorizon,
  DeferredObjectiveDiagnostic,
} from './diagnosticsBridge';
export type {
  DeferredObjectiveRescueMode,
  DeferredObjectiveRescuePermissions,
  DeferredObjectiveSettingsEntry,
  DeferredObjectiveSettingsV1,
} from './settings';
export type {
  DeferredObjective,
  DeferredObjectiveHorizonBucket,
  DeferredObjectiveHorizonPlan,
  DeferredObjectivePlannedBucket,
  DeferredObjectiveStep,
} from './types';
// Smart-task controller: the input-decoration stage the app wiring constructs
// and injects into the planner as `decorateDeferredObjectives`. The planner
// consumes the flat `DeferredDecorationBundle` it produces (see
// @pels/planner-types) and imports none of this subsystem. The admission
// appliers it owns stay internal (reached via ./admission directly).
export { DeferredObjectiveDecorationController } from './decorationController';
