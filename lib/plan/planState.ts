import type { BinaryControlCapabilityId } from '../../packages/contracts/src/types';
import { RESTORE_COOLDOWN_MS } from './planConstants';
import type { PowerFreshnessState } from './planPowerFreshness';
import type {
  BinaryControlDiscriminantProbe,
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

/**
 * Per-device surplus-absorb eligibility state, owned by
 * `lib/plan/admission/surplusAbsorb.ts`. `eligible` is the latched decision;
 * `sinceMs` stamps when it last flipped (the min-dwell floor) and
 * `pendingSinceMs` stamps when the opposite-flip condition first held (the
 * settle window). Absent entry == not eligible, no pending flip. In-memory only.
 */
export type SurplusEligibilityState = {
  eligible?: boolean;
  sinceMs?: number;
  pendingSinceMs?: number;
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
  | 'measuredPowerKw'
  | 'expectedPowerKw'
  | 'planningPowerKw'
  | 'binaryCommandPending'
  | 'stepCommandPending'
  | 'reason'
>
  // `binaryControl` is OMITTED from `DevicePlanDeviceBase` (orthogonal
  // `BinaryControlKind`), so it can't be Pick'd off the base — carry it as the
  // optional probe shape, sourced by the producer via `isBinaryPlanDevice`.
  & BinaryControlDiscriminantProbe
  & {
    pendingBinaryOnCommand: boolean;
    pendingBinaryOffCommand: boolean;
    pendingTargetCommand: boolean;
  };

/**
 * Shared plan-engine state. Modelled as a `class` (not a plain object) so the
 * executor's cross-cutting mutations go through narrow mutator METHODS: in
 * `lib/executor` (where `functional/immutable-data` / `no-param-reassign` are
 * ON) the old in-place `state.x = …` writes needed a per-site disable, whereas
 * `this.*` writes inside these methods are exempt via the rules' `ignoreClasses`.
 * All data fields stay PUBLIC; they're read transparently by reference across
 * `lib/plan`, and the planner mutates them directly there (allowed because
 * `lib/plan` is a hot-path dir with `functional/immutable-data` off). Construct
 * only via `createPlanEngineState`. No code spreads/clones this object, so the
 * loss of methods under a hypothetical spread is moot.
 */
export class PlanEngineState {
  appStartedAtMs: number;

  lastDeviceControlledMs: Record<string, number> = {};

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
  lastDeviceShedMs: Record<string, number> = {};

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
  shedDecidedMs: Record<string, number> = {};

  lastDeviceRestoreMs: Record<string, number> = {};

  activationAttemptByDevice: Record<string, ActivationAttemptState> = {};

  surplusEligibilityByDevice: Record<string, SurplusEligibilityState> = {};

  headroomCardByDevice: Record<string, HeadroomCardState> = {};

  pendingSheds: Set<string> = new Set<string>();

  pendingRestores: Set<string> = new Set<string>();

  pendingBinaryCommands: Record<string, {
    capabilityId: BinaryControlCapabilityId;
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
  }> = {};

  pendingTargetCommands: Record<string, PendingTargetCommandState> = {};

  lastInstabilityMs: number | null = null;

  lastRecoveryMs: number | null = null;

  lastRestoreMs: number | null = null;

  lastPlannedShedIds: Set<string> = new Set<string>();

  lastShedPlanMeasurementTs: number | null = null;

  swapByDevice: Record<string, SwapEntry> = {};

  inShortfall: boolean = false;

  restoreCooldownMs: number = RESTORE_COOLDOWN_MS;

  lastRestoreCooldownBumpMs: number | null = null;

  startupRestoreBlockedUntilMs: number | null = null;

  currentRebuildReason: string | null = null;

  lastPowerFreshnessState: PowerFreshnessState | null = null;

  hourlyBudgetExhausted: boolean = false;

  wasOvershoot: boolean = false;

  overshootLogged: boolean = false;

  softOvershootPendingSinceMs: number | null = null;

  overshootStartedMs: number | null = null;

  lastOvershootEscalationMs: number | null = null;

  lastOvershootMitigationMs: number | null = null;

  lastPlanTotalKw: number | null = null;

  lastPlanBuiltAtMs: number | null = null;

  lastPlanDevicesById: Record<string, OvershootTrackedPlanDevice> = {};

  temperatureBoostActiveByDevice: Record<string, boolean> = {};

  evBoostActiveByDevice: Record<string, boolean> = {};

  // Per-device: true when a surplus-absorb lift is the binding cause of this cycle's
  // planned target (it raised the setpoint above the price/base target and no deadline
  // floor overrode it). Drives the device card's "Raised to use your solar power" reason.
  surplusAbsorbActiveByDevice: Record<string, boolean> = {};

  lastOvershootSummarySignature: string | null = null;

  steppedRestoreRejectedByDevice: Record<string, {
    requestedStepId: string;
    lowestNonZeroStepId: string;
    shedDeviceCount: number;
  }> = {};

  keepInvariantShedBlockedByDevice: Record<string, {
    desiredStepId: string;
    lowestNonZeroStepId: string;
  }> = {};

  restoreDecisionLogByKey: Record<string, string> = {};

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
  }> = {};

  constructor(nowTs = Date.now()) {
    this.appStartedAtMs = nowTs;
  }

  /** Stamp the actuation-time shed clock for a device (executor turn-off). */
  markDeviceShed(deviceId: string, nowMs: number): void {
    this.lastDeviceShedMs[deviceId] = nowMs;
  }

  /** Clear the actuation-time shed clock for a device. */
  clearDeviceShed(deviceId: string): void {
    delete this.lastDeviceShedMs[deviceId];
  }

  /** Clear the decision-time shed clock for a device. */
  clearShedDecision(deviceId: string): void {
    delete this.shedDecidedMs[deviceId];
  }

  /** Record a stepped-load keep-invariant shed block for a device. */
  setKeepInvariantShedBlock(
    deviceId: string,
    entry: PlanEngineState['keepInvariantShedBlockedByDevice'][string],
  ): void {
    this.keepInvariantShedBlockedByDevice[deviceId] = entry;
  }

  /** Clear a stepped-load keep-invariant shed block for a device. */
  clearKeepInvariantShedBlock(deviceId: string): void {
    delete this.keepInvariantShedBlockedByDevice[deviceId];
  }

  /** Drop the pending target-command record for a device (confirmed/settled). */
  deletePendingTargetCommand(deviceId: string): void {
    delete this.pendingTargetCommands[deviceId];
  }

  /**
   * Clear the pending-target markers on a device's swap entry, dropping the
   * entry entirely once it carries no residual swap state.
   */
  clearPendingSwapTarget(deviceId: string): void {
    const swapEntry = this.swapByDevice[deviceId];
    if (!swapEntry) return;
    delete swapEntry.pendingTarget;
    delete swapEntry.timestamp;
    if (!swapEntry.swappedOutFor && swapEntry.lastPlanMeasurementTs === undefined) {
      delete this.swapByDevice[deviceId];
    }
  }
}

export function createPlanEngineState(nowTs = Date.now()): PlanEngineState {
  return new PlanEngineState(nowTs);
}
