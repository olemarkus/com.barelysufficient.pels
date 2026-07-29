import { getSteppedLoadStep } from '../lib/utils/deviceControlProfiles';
import { STEPPED_LOAD_COMMAND_RETRY_DELAYS_MS } from '../lib/plan/planConstants';
import { LOCAL_STEPPED_LOAD_COMMAND_PENDING_MS } from '../lib/plan/planObservationPolicy';
import {
  PELS_MEASURE_STEP_CAPABILITY_ID,
  PELS_TARGET_STEP_CAPABILITY_ID,
} from '../packages/shared-domain/src/steppedLoadSyntheticCapabilities';
import type {
  DeviceControlProfiles,
  SteppedLoadCommandStatus,
} from '../packages/contracts/src/types';

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

export const STEPPED_LOAD_COMMAND_STALE_MS = LOCAL_STEPPED_LOAD_COMMAND_PENDING_MS;

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
};

export type SteppedLoadReportedRuntimeState = {
  capabilityId: typeof PELS_MEASURE_STEP_CAPABILITY_ID;
  stepId: string;
  updatedAtMs: number;
  source: 'flow';
};

export type DeviceControlRuntimeState = {
  steppedLoadDesiredByDeviceId: Map<string, SteppedLoadDesiredRuntimeState>;
  steppedLoadReportedByDeviceId: Map<string, SteppedLoadReportedRuntimeState>;
  // Command-axis latch: the lowest-step initialization request was handed to
  // the device transport during this on-session. It is an optimistic planning
  // premise only — never reported/materialized evidence and never retry state.
  steppedLoadInitializedAtLowestStepByDeviceId: Map<string, string>;
  // Actual accepted step-command history for the current on-session. Kept
  // separate from `steppedLoadDesiredByDeviceId`, which may contain preserved
  // planner intent that was never issued.
  steppedLoadStepCommandIssuedByDeviceId: Set<string>;
  // Last observed raw binary on/off per stepped device, kept only to detect the
  // on→off transition that expires command-axis state from the ended on-session
  // (see `expireConfirmedDesiredStepOnBinaryOff`).
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
};

export const createDeviceControlRuntimeState = (): DeviceControlRuntimeState => ({
  steppedLoadDesiredByDeviceId: new Map(),
  steppedLoadReportedByDeviceId: new Map(),
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
export const expireConfirmedDesiredStepOnBinaryOff = (params: {
  runtimeState: DeviceControlRuntimeState;
  deviceId: string;
  observedOn: boolean | undefined;
}): void => {
  const { runtimeState, deviceId, observedOn } = params;
  if (typeof observedOn !== 'boolean') return;
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
  runtimeState.steppedLoadDesiredByDeviceId.set(deviceId, {
    ...desired,
    retryCount: 0,
    nextRetryAtMs: undefined,
    pending: false,
    status: 'success',
  });
};

export const markSteppedLoadDesiredStepIssued = (params: {
  runtimeState: DeviceControlRuntimeState;
  deviceId: string;
  desiredStepId: string;
  previousStepId?: string;
  issuedAtMs?: number;
  pendingWindowMs?: number;
  confirmationPolicy?: 'required' | 'assume_applied';
}): void => {
  const {
    runtimeState,
    deviceId,
    desiredStepId,
    previousStepId,
    issuedAtMs = Date.now(),
    pendingWindowMs,
    confirmationPolicy = 'required',
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
  profiles: DeviceControlProfiles;
  deviceId: string;
  stepId: string;
  reportedAtMs?: number;
}): ReportSteppedLoadActualStepResult => {
  const {
    runtimeState,
    profiles,
    deviceId,
    stepId,
    reportedAtMs = Date.now(),
  } = params;
  const profile = profiles[deviceId];
  if (!profile || profile.model !== 'stepped_load' || !getSteppedLoadStep(profile, stepId)) {
    return 'invalid';
  }

  const previousReport = runtimeState.steppedLoadReportedByDeviceId.get(deviceId);
  runtimeState.steppedLoadReportedByDeviceId.set(deviceId, {
    capabilityId: PELS_MEASURE_STEP_CAPABILITY_ID,
    stepId,
    updatedAtMs: reportedAtMs,
    source: 'flow',
  });

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

  return previousReport?.stepId !== stepId ? 'changed' : 'unchanged';
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
  return STEPPED_LOAD_COMMAND_RETRY_DELAYS_MS[
    Math.min(normalizedRetryCount, STEPPED_LOAD_COMMAND_RETRY_DELAYS_MS.length - 1)
  ];
}
