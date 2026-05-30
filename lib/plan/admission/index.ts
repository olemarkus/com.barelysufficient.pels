// Barrel for the admission pillar. Re-exports the public surface of the four
// admission modules — only what external consumers actually need. Internal
// helpers and types with zero external use are reached through their submodule
// directly, keeping the barrel honest about the public API.

export {
  ACTIVATION_BACKOFF_CLEAR_WINDOW_MS,
  ACTIVATION_BACKOFF_MAX_LEVEL,
  applyActivationPenalty,
  closeActivationAttemptForDevice,
  closeActivationAttemptForShed,
  getActivationPenaltyLevel,
  getActivationRestoreBlockCountdownTiming,
  getActivationRestoreBlockRemainingMs,
  isActivationObservationActiveNow,
  recordActivationAttemptStart,
  recordActivationSetback,
  syncActivationPenaltyState,
  syncConfirmedRestoreAttributionState,
} from './activationBackoff';
export type { ActivationAttemptSource } from './activationBackoff';

// The deferred-objective (smart-task) admission appliers moved to the smart-task
// controller in lib/objectives/deferredObjectives (PR-D2 of the controller
// extraction); the planner no longer owns them. The release-intent union lives
// in @pels/planner-types.

export {
  buildRestoreAdmissionLogFields,
  buildRestoreAdmissionMetrics,
  resolveRestoreDecisionPhase,
} from './reserve';
export type { RestoreAdmissionMetrics } from './reserve';

export {
  resolvePlanningTotalPower,
  updateGuardState,
} from './sheddingGuard';
