import { getSteppedLoadStep } from '../utils/deviceControlProfiles';
import { STEPPED_LOAD_COMMAND_RETRY_DELAYS_MS } from './commandRetrySchedule';
import { LOCAL_CONTROL_COMMAND_CONFIRMATION_MS } from '../observer/controlCommandConfirmation';
import { PELS_TARGET_STEP_CAPABILITY_ID } from '../../packages/shared-domain/src/steppedLoadSyntheticCapabilities';
import type { SteppedReportedStepStore } from '../observer/steppedReportedStep';
import type {
  DeviceControlProfiles,
  SteppedLoadCommandStatus,
} from '../../packages/contracts/src/types';

/**
 * Stepped-load command runtime state: the tracked desired-step command per
 * device (pending / stale / success lifecycle) plus the raw last flow-reported
 * step it is reconciled against. The commanded axis is OWNED here; the
 * flow-reported map is raw input that becomes observed evidence when snapshot
 * decoration resolves it (`appDeviceControlSteppedState.ts`). Since 2026-07-25
 * that resolution admits non-off flow reports unconditionally — the two axes stay
 * separate because they answer different questions (what PELS commanded vs what
 * the device attests), not because admission is withheld (`lib/device/AGENTS.md`).
 */

export const STEPPED_LOAD_COMMAND_STALE_MS = LOCAL_CONTROL_COMMAND_CONFIRMATION_MS;

export type SteppedLoadDesiredRuntimeState = {
  capabilityId: typeof PELS_TARGET_STEP_CAPABILITY_ID;
  stepId: string;
  previousStepId?: string;
  changedAtMs: number;
  lastIssuedAtMs?: number;
  pendingWindowMs?: number;
  retryCount: number;
  nextRetryAtMs?: number;
  pending: boolean;
  status: SteppedLoadCommandStatus;
  planningPowerW?: number;
  previousPlanningPowerW?: number;
  /** Present only when the producer admitted one rung above the confirmed EV ceiling. */
  targetPowerProbeConfirmedMaxPowerW?: number;
  /** First issue time for this probe; same-rung command retries must not slide settlement. */
  targetPowerProbeStartedAtMs?: number;
};

export type DeviceControlRuntimeState = {
  steppedLoadDesiredByDeviceId: Map<string, SteppedLoadDesiredRuntimeState>;
  // Command-axis latch: the lowest-step initialization request was handed to
  // the device transport during this on-session. It is an optimistic planning
  // premise only — never reported/materialized evidence and never retry state.
  steppedLoadInitializedAtLowestStepByDeviceId: Map<string, string>;
  // Actual accepted step-command history for the current on-session. Kept
  // separate from `steppedLoadDesiredByDeviceId`, which may contain preserved
  // planner intent that was never issued.
  steppedLoadStepCommandIssuedByDeviceId: Set<string>;
  /**
   * The settle cursor for the binary axis: the on/off state this layer last
   * SETTLED against, per device. Not a copy of the observer's state — the
   * observer serves what a device is now, and only the settler needs what it
   * was when the last conclusion was drawn.
   *
   * It exists because ending a command session is an EDGE (`expireConfirmedDesiredStepOnBinaryOff`):
   * a device that went on→off has ended the session its command belonged to,
   * while a command issued while the device was already off is a preparation
   * and must survive. Telling those apart needs a previous value, and the only
   * layer that can hold one honestly is the one drawing the conclusion — the
   * same reason `PendingBinaryCommandStore` keeps `recentConfirmedOffByDevice`.
   *
   * Deliberately NOT sourced from the observed-change event: that path is
   * push-only, and a missed event would leave a command session alive past its
   * on-session. The settle sweep is a pull, so it cannot miss the edge.
   */
  steppedLoadLastBinaryOnByDeviceId: Map<string, boolean>;
};

export type ReportSteppedLoadActualStepResult = 'changed' | 'unchanged' | 'invalid';

export type MarkSteppedLoadDesiredStepIssuedParams = {
  deviceId: string;
  desiredStepId: string;
  previousStepId?: string;
  issuedAtMs?: number;
  pendingWindowMs?: number;
  confirmationPolicy?: 'required' | 'assume_applied';
  planningPowerW?: number;
  previousPlanningPowerW?: number;
  targetPowerProbeConfirmedMaxPowerW?: number;
  /**
   * The command left our socket but nothing acknowledged it. The pending record
   * is still written — that is the point, it is what keeps the device unsettled
   * — but nothing downstream may turn the write into a conclusion ABOUT the
   * device. Specifically it must not arm the target-power reachability probe: a
   * probe that settles unobserved counts a failure and backs off for 15-60
   * minutes, which would let an abandoned socket answer "this charger cannot
   * reach that rung" on evidence that never existed.
   */
  unacknowledged?: boolean;
};

export const createDeviceControlRuntimeState = (): DeviceControlRuntimeState => ({
  steppedLoadDesiredByDeviceId: new Map(),
  steppedLoadInitializedAtLowestStepByDeviceId: new Map(),
  steppedLoadStepCommandIssuedByDeviceId: new Set(),
  steppedLoadLastBinaryOnByDeviceId: new Map(),
});

// A command is evidence about the device's configuration AT THE TIME it was
// given. Once the device transitions on→off, that command-axis state belongs to
// the ended on-session and must not suppress initialization after a later
// unknown-level turn-on or fast-track a restore-from-off. Delete it on the
// observed on→off transition. A preparation command given WHILE already off
// sees no such transition and survives untouched.
//
// Still wanted after flow reports became admissible while off (2026-07-25): the
// observed axis now usually shows the drift directly, but only for devices whose
// flow actually reports while paused. This expiry is the guard for the ones that
// go quiet, and it costs nothing when the report does arrive.
/**
 * `observedOn` is strictly boolean, and the producer resolves it with the ONE
 * fold that owns the question: `resolveCurrentOn` (`lib/observer/observedState.ts`),
 * `!(binaryOff || steppedOff)`. There is no third state to model — a device with
 * no binary axis is not "unknown", it is a device that may always draw, which
 * the snapshot contract states outright ("consumers must treat its absence
 * exactly like the old fabricated `currentOn: true`").
 */
export const expireConfirmedDesiredStepOnBinaryOff = (params: {
  runtimeState: DeviceControlRuntimeState;
  deviceId: string;
  observedOn: boolean;
}): void => {
  const { runtimeState, deviceId, observedOn } = params;
  if (!observedOn) {
    runtimeState.steppedLoadInitializedAtLowestStepByDeviceId.delete(deviceId);
    runtimeState.steppedLoadStepCommandIssuedByDeviceId.delete(deviceId);
  }
  const previousOn = runtimeState.steppedLoadLastBinaryOnByDeviceId.get(deviceId);
  runtimeState.steppedLoadLastBinaryOnByDeviceId.set(deviceId, observedOn);
  if (previousOn !== true || observedOn) return;
  runtimeState.steppedLoadDesiredByDeviceId.delete(deviceId);
};

// Mark the tracked desired step command confirmed. Called from the decorate-time
// reported-step match; a report matching the commanded step confirms the COMMANDED
// axis, independently of it also landing on the observed one.
export const confirmSteppedLoadDesiredStep = (params: {
  runtimeState: DeviceControlRuntimeState;
  deviceId: string;
  desired: SteppedLoadDesiredRuntimeState;
}): void => {
  const { runtimeState, deviceId, desired } = params;
  const {
    targetPowerProbeConfirmedMaxPowerW: _targetPowerProbeConfirmedMaxPowerW,
    targetPowerProbeStartedAtMs: _targetPowerProbeStartedAtMs,
    ...settledDesired
  } = desired;
  runtimeState.steppedLoadDesiredByDeviceId.set(deviceId, {
    ...settledDesired,
    retryCount: 0,
    nextRetryAtMs: undefined,
    pending: false,
    status: 'success',
  });
};

const buildSteppedLoadPowerMetadata = (params: {
  previousDesired: SteppedLoadDesiredRuntimeState | undefined;
  desiredStepId: string;
  issuedAtMs: number;
  planningPowerW: number | undefined;
  previousPlanningPowerW: number | undefined;
  targetPowerProbeConfirmedMaxPowerW: number | undefined;
}): Partial<SteppedLoadDesiredRuntimeState> => {
  const {
    previousDesired,
    desiredStepId,
    issuedAtMs,
    planningPowerW,
    previousPlanningPowerW,
    targetPowerProbeConfirmedMaxPowerW,
  } = params;
  const continuingTargetPowerProbe = targetPowerProbeConfirmedMaxPowerW !== undefined
    && previousDesired?.stepId === desiredStepId
    && previousDesired.planningPowerW === planningPowerW
    && previousDesired.targetPowerProbeConfirmedMaxPowerW === targetPowerProbeConfirmedMaxPowerW
    && previousDesired.targetPowerProbeStartedAtMs !== undefined;
  const targetPowerProbeStartedAtMs = continuingTargetPowerProbe
    ? previousDesired.targetPowerProbeStartedAtMs
    : issuedAtMs;
  return {
    ...(planningPowerW !== undefined ? { planningPowerW } : {}),
    ...(previousPlanningPowerW !== undefined ? { previousPlanningPowerW } : {}),
    ...(targetPowerProbeConfirmedMaxPowerW !== undefined
      ? { targetPowerProbeConfirmedMaxPowerW, targetPowerProbeStartedAtMs }
      : {}),
  };
};

export const markSteppedLoadDesiredStepIssued = (params: {
  runtimeState: DeviceControlRuntimeState;
  deviceId: string;
  desiredStepId: string;
  previousStepId?: string;
  issuedAtMs?: number;
  pendingWindowMs?: number;
  confirmationPolicy?: 'required' | 'assume_applied';
  planningPowerW?: number;
  previousPlanningPowerW?: number;
  targetPowerProbeConfirmedMaxPowerW?: number;
}): void => {
  const {
    runtimeState,
    deviceId,
    desiredStepId,
    previousStepId,
    issuedAtMs = Date.now(),
    pendingWindowMs,
    confirmationPolicy = 'required',
    planningPowerW,
    previousPlanningPowerW,
    targetPowerProbeConfirmedMaxPowerW,
  } = params;
  if (confirmationPolicy === 'assume_applied') {
    runtimeState.steppedLoadInitializedAtLowestStepByDeviceId.set(deviceId, desiredStepId);
    runtimeState.steppedLoadStepCommandIssuedByDeviceId.add(deviceId);
    return;
  }
  runtimeState.steppedLoadStepCommandIssuedByDeviceId.add(deviceId);
  const previousDesired = runtimeState.steppedLoadDesiredByDeviceId.get(deviceId);
  const shouldIncrementRetryCount = previousDesired?.stepId === desiredStepId
    && previousDesired.status !== 'success';
  const retryCount = shouldIncrementRetryCount
    ? previousDesired.retryCount + 1
    : 0;
  runtimeState.steppedLoadDesiredByDeviceId.set(deviceId, {
    capabilityId: PELS_TARGET_STEP_CAPABILITY_ID,
    stepId: desiredStepId,
    previousStepId,
    changedAtMs: issuedAtMs,
    lastIssuedAtMs: issuedAtMs,
    pendingWindowMs,
    retryCount,
    nextRetryAtMs: undefined,
    pending: true,
    status: 'pending',
    ...buildSteppedLoadPowerMetadata({
      previousDesired,
      desiredStepId,
      issuedAtMs,
      planningPowerW,
      previousPlanningPowerW,
      targetPowerProbeConfirmedMaxPowerW,
    }),
  });
};

export const preserveSteppedLoadDesiredStep = (params: {
  runtimeState: DeviceControlRuntimeState;
  deviceId: string;
  desiredStepId: string;
  previousStepId?: string;
  changedAtMs?: number;
  status?: SteppedLoadCommandStatus;
}): void => {
  const {
    runtimeState,
    deviceId,
    desiredStepId,
    previousStepId,
    changedAtMs = Date.now(),
    status = 'idle',
  } = params;
  runtimeState.steppedLoadDesiredByDeviceId.set(deviceId, {
    capabilityId: PELS_TARGET_STEP_CAPABILITY_ID,
    stepId: desiredStepId,
    previousStepId,
    changedAtMs,
    retryCount: 0,
    nextRetryAtMs: undefined,
    pending: false,
    status,
  });
};

export const reportSteppedLoadActualStep = (params: {
  runtimeState: DeviceControlRuntimeState;
  reportedStore: SteppedReportedStepStore;
  profiles: DeviceControlProfiles;
  deviceId: string;
  stepId: string;
  reportedAtMs?: number;
  planningPowerW?: number;
}): ReportSteppedLoadActualStepResult => {
  const {
    runtimeState,
    reportedStore,
    profiles,
    deviceId,
    stepId,
    reportedAtMs = Date.now(),
    planningPowerW,
  } = params;
  const profile = profiles[deviceId];
  if (!profile || !getSteppedLoadStep(profile, stepId)) {
    return 'invalid';
  }

  // The ladder check above is this layer's to make (it holds the profile). The
  // record, and the verdict on whether it is news, belong to the observer.
  const changed = reportedStore.record({ deviceId, stepId, reportedAtMs, planningPowerW });

  const desired = runtimeState.steppedLoadDesiredByDeviceId.get(deviceId);
  if (desired?.stepId === stepId) {
    confirmSteppedLoadDesiredStep({ runtimeState, deviceId, desired });
  } else if (desired?.status === 'success') {
    // Fresh trusted telemetry contradicts an earlier confirmation (e.g. the
    // charger current was re-zeroed after the flow confirmed the prepared
    // step). The confirmation must lose to the newer report so a stale
    // 'success' cannot fast-track a restore whose preparation was un-applied.
    runtimeState.steppedLoadDesiredByDeviceId.set(deviceId, {
      ...desired,
      pending: false,
      status: 'idle',
    });
  }

  return changed;
};

export const pruneStaleSteppedLoadCommandStates = (
  runtimeState: DeviceControlRuntimeState,
  nowMs: number = Date.now(),
): boolean => {
  let changed = false;
  for (const [deviceId, desired] of runtimeState.steppedLoadDesiredByDeviceId.entries()) {
    if (!desired.pending || typeof desired.lastIssuedAtMs !== 'number') continue;
    const pendingWindowMs = desired.pendingWindowMs ?? STEPPED_LOAD_COMMAND_STALE_MS;
    if (nowMs - desired.lastIssuedAtMs < pendingWindowMs) continue;
    runtimeState.steppedLoadDesiredByDeviceId.set(deviceId, {
      ...desired,
      nextRetryAtMs:
        desired.lastIssuedAtMs
        + pendingWindowMs
        + resolveSteppedLoadCommandRetryDelayMs(desired.retryCount),
      pending: false,
      status: 'stale',
    });
    changed = true;
  }
  return changed;
};

function resolveSteppedLoadCommandRetryDelayMs(retryCount: number): number {
  const normalizedRetryCount = Number.isFinite(retryCount) ? Math.max(0, Math.trunc(retryCount)) : 0;
  // The ladder is a fixed const tuple and the index is clamped into it at both ends, so
  // the first rung is an unreachable rather than a substituted value.
  return STEPPED_LOAD_COMMAND_RETRY_DELAYS_MS[
    Math.min(normalizedRetryCount, STEPPED_LOAD_COMMAND_RETRY_DELAYS_MS.length - 1)
  ] ?? STEPPED_LOAD_COMMAND_RETRY_DELAYS_MS[0];
}
