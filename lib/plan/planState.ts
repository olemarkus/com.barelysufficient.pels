import { RESTORE_COOLDOWN_MS } from './planConstants';
import type { PowerFreshnessState } from './planPowerFreshness';
import type {
  DevicePlanDevice,
  PendingTargetCommandStatus,
  PendingTargetObservationSource,
} from './planTypes';

export type ActivationAttemptSource = 'pels_restore' | 'tracked_step_up';
export type PendingBinaryLogContext = 'capacity' | 'capacity_control_off';
export type PendingBinaryRestoreSource = 'shed_state' | 'current_plan';
export type PendingBinaryActuationMode = 'plan' | 'reconcile';

export type PendingTargetCommandState = {
  capabilityId: string;
  desired: number;
  startedMs: number;
  lastAttemptMs: number;
  retryCount: number;
  nextRetryAtMs: number;
  status: PendingTargetCommandStatus;
  lastObservedValue?: unknown;
  lastObservedSource?: PendingTargetObservationSource;
  lastObservedAtMs?: number;
  lastWaitingLogAtMs?: number;
};

export type ActivationAttemptState = {
  penaltyLevel?: number;
  lastSetbackMs?: number;
  startedMs?: number;
  source?: ActivationAttemptSource;
  /**
   * Set to the timestamp of the first clean whole-home sample seen after the
   * attempt started. Used as evidence at window expiry that the household
   * total was actually known and within limits during the attribution window,
   * not just that no overshoot was attributed (which would also be true if
   * the main meter was stale for the entire window).
   */
  cleanWholeHomeSampleAtMs?: number;
};

export type HeadroomCardState = {
  lastUsageKw?: number;
  lastUsageFreshnessMs?: number;
  deviceName?: string;
  lastStepDownMs?: number;
};

export type SwapEntry = {
  swappedOutFor?: string;
  pendingTarget?: boolean;
  timestamp?: number;
  lastPlanMeasurementTs?: number;
  requestedTargetStepId?: string;
  requestedDesiredStepId?: string;
};

export type OvershootTrackedPlanDevice = Pick<
  DevicePlanDevice,
  | 'id'
  | 'name'
  | 'controllable'
  | 'plannedState'
  | 'currentState'
  | 'binaryControl'
  | 'measuredPowerKw'
  | 'expectedPowerKw'
  | 'planningPowerKw'
  | 'observationStale'
  | 'binaryCommandPending'
  | 'stepCommandPending'
  | 'reason'
> & {
  pendingBinaryOnCommand: boolean;
  pendingBinaryOffCommand: boolean;
  pendingTargetCommand: boolean;
};

export type PlanEngineState = {
  appStartedAtMs: number;
  lastDeviceControlledMs: Record<string, number>;
  /**
   * Actuation-time clock: the timestamp the executor last actually turned a
   * device off for capacity. Written by the executor — `recordShedActuation`
   * on a real turn-off, plus the degenerate no-onoff shed path in
   * `binaryExecutor`. Drives the actuation-recency readers —
   * the 5s shed throttle, the cooldown countdown card, the reconcile window,
   * and the recent-shed restore backoff. Do NOT use it to answer "is this
   * device in shed posture?": a device the plan decided to shed but that was
   * already off (write skipped) has no entry here. That decision-time
   * question is `shedDecidedMs`.
   */
  lastDeviceShedMs: Record<string, number>;
  /**
   * Decision-time clock: the timestamp the planner decided a device should be
   * held in capacity-shed posture. Owned by the planner — edge-set at plan
   * finalization for every device entering `lastPlannedShedIds` (so a
   * decided-but-already-off device is recorded even when the executor skips
   * the write), and cleared on restore exactly where `lastDeviceShedMs` is
   * (controlled restores age it out via the `lastDeviceRestoreMs` comparison;
   * uncontrolled `capacity_control_off` restores delete it). This is the
   * intent/existence fact the restore-eligibility readers consult —
   * recovering, stepped-restore blocking, restore-log source, and the
   * uncontrolled-restore stability gate — so a write-skipped shed no longer
   * under-stamps and lets a device restore early. See
   * `notes/state-management/deferred-objective-lifecycle-carveout.md`.
   */
  shedDecidedMs: Record<string, number>;
  lastDeviceRestoreMs: Record<string, number>;
  activationAttemptByDevice: Record<string, ActivationAttemptState>;
  headroomCardByDevice: Record<string, HeadroomCardState>;
  pendingSheds: Set<string>;
  pendingRestores: Set<string>;
  pendingBinaryCommands: Record<string, {
    capabilityId: 'onoff' | 'evcharger_charging';
    desired: boolean;
    startedMs: number;
    pendingMs?: number;
    flowBackedControl?: boolean;
    logContext?: PendingBinaryLogContext;
    restoreSource?: PendingBinaryRestoreSource;
    actuationMode?: PendingBinaryActuationMode;
    reason?: string;
    // True when issued by the smart-task lifecycle-end disable path (not a
    // capacity shed); routes the deferred flow-backed confirmation through the
    // diagnostic-only release recorder so it does not stamp the cooldown markers.
    lifecycleRelease?: boolean;
    lastObservedValue?: boolean | string;
    lastObservedSource?: PendingTargetObservationSource;
    lastObservedAtMs?: number;
  }>;
  pendingTargetCommands: Record<string, PendingTargetCommandState>;
  lastInstabilityMs: number | null;
  lastRecoveryMs: number | null;
  lastRestoreMs: number | null;
  lastPlannedShedIds: Set<string>;
  lastShedPlanMeasurementTs: number | null;
  swapByDevice: Record<string, SwapEntry>;
  inShortfall: boolean;
  restoreCooldownMs: number;
  lastRestoreCooldownBumpMs: number | null;
  startupRestoreBlockedUntilMs: number | null;
  currentRebuildReason: string | null;
  lastPowerFreshnessState: PowerFreshnessState | null;
  hourlyBudgetExhausted: boolean;
  wasOvershoot: boolean;
  overshootLogged: boolean;
  softOvershootPendingSinceMs: number | null;
  overshootStartedMs: number | null;
  lastOvershootEscalationMs: number | null;
  lastOvershootMitigationMs: number | null;
  lastPlanTotalKw: number | null;
  lastPlanBuiltAtMs: number | null;
  lastPlanDevicesById: Record<string, OvershootTrackedPlanDevice>;
  temperatureBoostActiveByDevice: Record<string, boolean>;
  evBoostActiveByDevice: Record<string, boolean>;
  lastOvershootSummarySignature: string | null;
  steppedRestoreRejectedByDevice: Record<string, {
    requestedStepId: string;
    lowestNonZeroStepId: string;
    shedDeviceCount: number;
  }>;
  keepInvariantShedBlockedByDevice: Record<string, {
    desiredStepId: string;
    lowestNonZeroStepId: string;
  }>;
  restoreDecisionLogByKey: Record<string, string>;
  /**
   * Per-device transient state for the mode-target capability read in
   * `resolveTemperatureSeed`. Used by the abandon-grace window so a single
   * transient SDK miss on `getPrimaryTargetCapability(dev.targets)?.value`
   * does not drop the device from the plan, and by the per-device emit
   * throttle on `missing_mode_target` / `missing_mode_target_and_current_target`
   * so a stuck misconfigured device does not flood the log buffer when the
   * `plan` debug topic is enabled. In-memory only per
   * `feedback_homey_sdk_unreliable` — on restart the first cycle re-emits as
   * expected.
   */
  modeTargetMissingByDevice: Record<string, {
    missingCycles: number;
    cachedTargetValue?: number;
    /**
     * Capability ID the `cachedTargetValue` was read from. Compared against
     * the current primary target capability when the grace path considers
     * reusing the cache so a device re-pair (or driver swap) during the
     * grace window can't reuse a value against a different capability.
     */
    cachedTargetCapabilityId?: string;
    lastEmitAtMs?: number;
    lastEmitEvent?: 'missing_mode_target' | 'missing_mode_target_and_current_target';
  }>;
};

export function createPlanEngineState(nowTs = Date.now()): PlanEngineState {
  return {
    appStartedAtMs: nowTs,
    lastDeviceControlledMs: {},
    lastDeviceShedMs: {},
    shedDecidedMs: {},
    lastDeviceRestoreMs: {},
    activationAttemptByDevice: {},
    headroomCardByDevice: {},
    pendingSheds: new Set<string>(),
    pendingRestores: new Set<string>(),
    pendingBinaryCommands: {},
    pendingTargetCommands: {},
    lastInstabilityMs: null,
    lastRecoveryMs: null,
    lastRestoreMs: null,
    lastPlannedShedIds: new Set<string>(),
    lastShedPlanMeasurementTs: null,
    swapByDevice: {},
    inShortfall: false,
    restoreCooldownMs: RESTORE_COOLDOWN_MS,
    lastRestoreCooldownBumpMs: null,
    startupRestoreBlockedUntilMs: null,
    currentRebuildReason: null,
    lastPowerFreshnessState: null,
    hourlyBudgetExhausted: false,
    wasOvershoot: false,
    overshootLogged: false,
    softOvershootPendingSinceMs: null,
    overshootStartedMs: null,
    lastOvershootEscalationMs: null,
    lastOvershootMitigationMs: null,
    lastPlanTotalKw: null,
    lastPlanBuiltAtMs: null,
    lastPlanDevicesById: {},
    temperatureBoostActiveByDevice: {},
    evBoostActiveByDevice: {},
    lastOvershootSummarySignature: null,
    steppedRestoreRejectedByDevice: {},
    keepInvariantShedBlockedByDevice: {},
    restoreDecisionLogByKey: {},
    modeTargetMissingByDevice: {},
  };
}
