// Barrel for the admission pillar. Re-exports the public surface of the four
// admission modules — only what external consumers actually need. Internal
// helpers and types with zero external use are reached through their submodule
// directly, keeping the barrel honest about the public API.

export {
  ACTIVATION_ATTEMPT_ATTRIBUTION_WINDOW_MS,
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

export {
  clearSurplusEligibility,
  clearSurplusTrackingStep,
  SURPLUS_ABSORB_HARD_OFF_IMPORT_KW,
  SURPLUS_TRACK_STEP_MIN_INTERVAL_MS,
  SURPLUS_ABSORB_RESERVE_KW,
  syncSurplusEligibilityState,
} from './surplusAbsorb';

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
  buildReservedForStartReason,
  resolveHeadroomReserves,
  resolveReserveAdmission,
} from './headroomReserve';
export type { HeadroomReserve } from './headroomReserve';

export {
  updateGuardState,
} from './sheddingGuard';
