import {
  getSteppedLoadLowestActiveStep,
  getSteppedLoadStep,
  normalizeDeviceControlProfiles,
  resolveSteppedLoadPlanningPowerKw,
} from '../utils/deviceControlProfiles';
import { isNativeSteppedLoadControlEnabled } from '../device/nativeSteppedLoadWiring';
import type { Logger as PinoLogger, StructuredDebugEmitter } from '../logging/logger';
import type { DevicePlan } from '../plan/planTypes';
import type {
  DecoratedDeviceSnapshot,
  DeviceControlModel,
  DeviceControlProfiles,
  SteppedLoadCommandStatus,
  SteppedLoadProfile,
  TargetDeviceSnapshot,
} from '../../packages/contracts/src/types';
import { STEPPED_LOAD_COMMAND_RETRY_DELAYS_MS } from '../plan/planConstants';
import { LOCAL_STEPPED_LOAD_COMMAND_PENDING_MS } from '../plan/planObservationPolicy';
import {
  PELS_MEASURE_STEP_CAPABILITY_ID,
  PELS_TARGET_STEP_CAPABILITY_ID,
} from '../../packages/shared-domain/src/steppedLoadSyntheticCapabilities';
import {
  buildSteppedLoadSnapshotStepFields,
  resolveNativeSteppedLoadProfile,
  resolveSteppedLoadCurrentOn,
  shouldSuppressSteppedLoadFlowReport,
} from './appDeviceControlSteppedState';
import { emitSteppedFeedbackLog } from './appDeviceControlFeedback';
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
  steppedLoadDesiredByDeviceId: Record<string, SteppedLoadDesiredRuntimeState>;
  steppedLoadReportedByDeviceId: Record<string, SteppedLoadReportedRuntimeState>;
};
export type ReportSteppedLoadActualStepResult = 'changed' | 'unchanged' | 'invalid';
export type MarkSteppedLoadDesiredStepIssuedParams = {
  deviceId: string;
  desiredStepId: string;
  previousStepId?: string;
  issuedAtMs?: number;
  pendingWindowMs?: number;
};
export const createDeviceControlRuntimeState = (): DeviceControlRuntimeState => ({
  steppedLoadDesiredByDeviceId: {},
  steppedLoadReportedByDeviceId: {},
});
export const normalizeStoredDeviceControlProfiles = normalizeDeviceControlProfiles;
export const resolveDefaultControlModel = (device: TargetDeviceSnapshot): DeviceControlModel => {
  if (device.controlModel) return device.controlModel;
  if (device.deviceType === 'temperature') return 'temperature_target';
  return 'binary_power';
};

const asSteppedLoadProfile = (
  profile: SteppedLoadProfile | undefined,
): SteppedLoadProfile | null => (
  profile?.model === 'stepped_load' ? profile : null
);

const resolveSuggestedSteppedLoadProfile = (
  snapshot: TargetDeviceSnapshot | undefined,
): SteppedLoadProfile | null => (
  snapshot?.controlModel === 'stepped_load'
    ? asSteppedLoadProfile(snapshot.suggestedSteppedLoadProfile)
    : null
);

export const resolveEffectiveSteppedLoadProfile = (params: {
  snapshot?: TargetDeviceSnapshot;
  profiles: DeviceControlProfiles;
  deviceId: string;
}): SteppedLoadProfile | null => {
  const { snapshot, profiles, deviceId } = params;
  const nativeProfile = snapshot ? resolveNativeSteppedLoadProfile(snapshot) : null;
  const storedProfile = asSteppedLoadProfile(profiles[deviceId]);
  const snapshotProfile = snapshot?.steppedLoadProfile?.model === 'stepped_load'
    ? snapshot.steppedLoadProfile
    : null;
  if (nativeProfile) return nativeProfile;
  if (snapshot?.targetPowerConfig && snapshotProfile) return snapshotProfile;
  if (storedProfile) return storedProfile;
  if (snapshotProfile) return snapshotProfile;
  return resolveSuggestedSteppedLoadProfile(snapshot);
};

/* eslint-disable complexity --
 * Decoration resolves reported step state plus legacy planner fallback in one place.
 */
export const decorateSnapshotWithDeviceControl = (params: {
  snapshot: TargetDeviceSnapshot;
  profiles: DeviceControlProfiles;
  runtimeState: DeviceControlRuntimeState;
  nowMs?: number;
}): DecoratedDeviceSnapshot => {
  const { snapshot, profiles, runtimeState, nowMs = Date.now() } = params;
  const nativeProfile = resolveNativeSteppedLoadProfile(snapshot);
  const profile = resolveEffectiveSteppedLoadProfile({
    snapshot,
    profiles,
    deviceId: snapshot.id,
  });
  if (!profile) {
    return {
      ...snapshot,
      controlModel: resolveDefaultControlModel(snapshot),
    };
  }

  pruneStaleSteppedLoadCommandStates(runtimeState, nowMs);

  const desired = runtimeState.steppedLoadDesiredByDeviceId[snapshot.id];
  const reported = runtimeState.steppedLoadReportedByDeviceId[snapshot.id];
  const nativeSteppedControlEnabled = nativeProfile !== null;
  const snapshotReportedStepId = getSteppedLoadStep(profile, snapshot.reportedStepId)?.id;
  const nativeReportedStepId = nativeSteppedControlEnabled ? snapshotReportedStepId : undefined;
  if (nativeSteppedControlEnabled && reported) {
    /* eslint-disable-next-line functional/immutable-data -- Shared stepped-load runtime cache update. */
    delete runtimeState.steppedLoadReportedByDeviceId[snapshot.id];
  }
  const confirmedReportedStepId = nativeReportedStepId ?? snapshotReportedStepId;
  if (confirmedReportedStepId && desired?.stepId === confirmedReportedStepId) {
    /* eslint-disable-next-line functional/immutable-data -- Shared stepped-load runtime cache update. */
    runtimeState.steppedLoadDesiredByDeviceId[snapshot.id] = {
      ...desired,
      retryCount: 0,
      nextRetryAtMs: undefined,
      pending: false,
      status: 'success',
    };
  }
  const currentDesired = runtimeState.steppedLoadDesiredByDeviceId[snapshot.id];
  const fallbackStepId = getSteppedLoadLowestActiveStep(profile)?.id;
  const stepFields = buildSteppedLoadSnapshotStepFields({
    profile,
    nowMs,
    currentOn: snapshot.currentOn,
    nativeSteppedControlEnabled,
    nativeReportedStep: { stepId: nativeReportedStepId, observedAtMs: snapshot.lastUpdated },
    flowReportedStep: {
      stepId: reported?.stepId ?? (nativeSteppedControlEnabled ? undefined : snapshotReportedStepId),
      observedAtMs: reported?.updatedAtMs ?? snapshot.lastUpdated,
    },
    targetStep: {
      stepId: currentDesired?.stepId,
      changedAtMs: currentDesired?.changedAtMs,
      status: currentDesired?.status,
    },
    fallbackStepId,
  });
  const selectedStepId = stepFields.selectedStepId;
  const planningPowerKw = resolveSteppedLoadPlanningPowerKw(profile, selectedStepId);

  return {
    ...snapshot,
    controlModel: 'stepped_load',
    steppedLoadProfile: profile,
    reportedStepId: stepFields.reportedStepId,
    targetStepId: stepFields.targetStepId,
    selectedStepId,
    desiredStepId: stepFields.desiredStepId,
    previousStepId: currentDesired?.previousStepId,
    planningPowerKw,
    currentOn: resolveSteppedLoadCurrentOn({ snapshot, profile, selectedStepId }),
    lastStepCommandIssuedAt: currentDesired?.lastIssuedAtMs,
    stepCommandRetryCount: currentDesired?.retryCount,
    nextStepCommandRetryAtMs: currentDesired?.nextRetryAtMs,
    stepCommandPending: currentDesired?.pending ?? false,
    stepCommandStatus: currentDesired?.status ?? 'idle',
  };
};
/* eslint-enable complexity */

export const markSteppedLoadDesiredStepIssued = (params: {
  runtimeState: DeviceControlRuntimeState;
  deviceId: string;
  desiredStepId: string;
  previousStepId?: string;
  issuedAtMs?: number;
  pendingWindowMs?: number;
}): void => {
  const {
    runtimeState,
    deviceId,
    desiredStepId,
    previousStepId,
    issuedAtMs = Date.now(),
    pendingWindowMs,
  } = params;
  const previousDesired = runtimeState.steppedLoadDesiredByDeviceId[deviceId];
  const shouldIncrementRetryCount = previousDesired?.stepId === desiredStepId
    && previousDesired.status !== 'success';
  const retryCount = shouldIncrementRetryCount
    ? previousDesired.retryCount + 1
    : 0;
  /* eslint-disable functional/immutable-data -- Shared runtime cache update. */
  runtimeState.steppedLoadDesiredByDeviceId[deviceId] = {
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
  };
  /* eslint-enable functional/immutable-data */
};

const preserveSteppedLoadDesiredStep = (params: {
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
  /* eslint-disable functional/immutable-data -- Shared runtime cache update. */
  runtimeState.steppedLoadDesiredByDeviceId[deviceId] = {
    capabilityId: PELS_TARGET_STEP_CAPABILITY_ID,
    stepId: desiredStepId,
    previousStepId,
    changedAtMs,
    retryCount: 0,
    nextRetryAtMs: undefined,
    pending: false,
    status,
  };
  /* eslint-enable functional/immutable-data */
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

  const previousReport = runtimeState.steppedLoadReportedByDeviceId[deviceId];
  /* eslint-disable functional/immutable-data -- Shared runtime cache update. */
  runtimeState.steppedLoadReportedByDeviceId[deviceId] = {
    capabilityId: PELS_MEASURE_STEP_CAPABILITY_ID,
    stepId,
    updatedAtMs: reportedAtMs,
    source: 'flow',
  };
  /* eslint-enable functional/immutable-data */

  const desired = runtimeState.steppedLoadDesiredByDeviceId[deviceId];
  if (desired?.stepId === stepId) {
    /* eslint-disable functional/immutable-data -- Shared runtime cache update. */
    runtimeState.steppedLoadDesiredByDeviceId[deviceId] = {
      ...desired,
      retryCount: 0,
      nextRetryAtMs: undefined,
      pending: false,
      status: 'success',
    };
    /* eslint-enable functional/immutable-data */
  }

  return previousReport?.stepId !== stepId ? 'changed' : 'unchanged';
};

export const pruneStaleSteppedLoadCommandStates = (
  runtimeState: DeviceControlRuntimeState,
  nowMs: number = Date.now(),
): boolean => {
  let changed = false;
  for (const [deviceId, desired] of Object.entries(runtimeState.steppedLoadDesiredByDeviceId)) {
    if (!desired.pending || typeof desired.lastIssuedAtMs !== 'number') continue;
    const pendingWindowMs = desired.pendingWindowMs ?? STEPPED_LOAD_COMMAND_STALE_MS;
    if (nowMs - desired.lastIssuedAtMs < pendingWindowMs) continue;
    /* eslint-disable functional/immutable-data, no-param-reassign --
     * Shared runtime cache update during stale-step pruning.
     */
    runtimeState.steppedLoadDesiredByDeviceId[deviceId] = {
      ...desired,
      nextRetryAtMs:
        desired.lastIssuedAtMs
        + pendingWindowMs
        + resolveSteppedLoadCommandRetryDelayMs(desired.retryCount),
      pending: false,
      status: 'stale',
    };
    /* eslint-enable functional/immutable-data, no-param-reassign */
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

export class AppDeviceControlHelpers {
  private readonly runtimeState: DeviceControlRuntimeState = createDeviceControlRuntimeState();

  constructor(private readonly deps: {
    getProfiles: () => DeviceControlProfiles;
    getDeviceSnapshots: () => TargetDeviceSnapshot[];
    getLatestPlanSnapshot?: () => DevicePlan | null;
    getStructuredLogger: (component: string) => PinoLogger | undefined;
    debugStructured: StructuredDebugEmitter;
  }) {}

  getSteppedLoadProfile(deviceId: string): SteppedLoadProfile | null {
    const snapshot = this.deps.getDeviceSnapshots().find((device) => device.id === deviceId);
    return resolveEffectiveSteppedLoadProfile({
      snapshot,
      profiles: this.deps.getProfiles(),
      deviceId,
    });
  }

  decorateTargetSnapshotList(snapshot: TargetDeviceSnapshot[]): DecoratedDeviceSnapshot[] {
    const nowMs = Date.now();
    pruneStaleSteppedLoadCommandStates(this.runtimeState, nowMs);
    const profiles = this.deps.getProfiles();
    return snapshot.map((device) => decorateSnapshotWithDeviceControl({
      snapshot: device,
      profiles,
      runtimeState: this.runtimeState,
      nowMs,
    }));
  }

  markSteppedLoadDesiredStepIssued(params: MarkSteppedLoadDesiredStepIssuedParams): void {
    markSteppedLoadDesiredStepIssued({
      runtimeState: this.runtimeState,
      deviceId: params.deviceId,
      desiredStepId: params.desiredStepId,
      previousStepId: params.previousStepId,
      issuedAtMs: params.issuedAtMs,
      pendingWindowMs: params.pendingWindowMs,
    });
  }

  reportSteppedLoadActualStep(deviceId: string, stepId: string): ReportSteppedLoadActualStepResult {
    const snapshot = this.deps.getDeviceSnapshots().find((device) => device.id === deviceId);
    const deviceName = snapshot ? snapshot.name.trim() : `device ${deviceId}`;
    if (snapshot && isNativeSteppedLoadControlEnabled(snapshot)) {
      delete this.runtimeState.steppedLoadReportedByDeviceId[deviceId];
      this.deps.debugStructured({
        event: 'stepped_load_feedback_ignored', reason: 'native_wiring_enabled', deviceName,
      });
      return 'unchanged';
    }
    const storedProfiles = this.deps.getProfiles();
    const profile = this.resolveSteppedLoadFeedbackProfile(deviceId, snapshot, storedProfiles);
    if (!profile || profile.model !== 'stepped_load' || !getSteppedLoadStep(profile, stepId)) {
      this.deps.debugStructured({ event: 'stepped_load_feedback_ignored', reason: 'invalid_step', deviceName, stepId });
      return 'invalid';
    }
    if (shouldSuppressSteppedLoadFlowReport({
      profile,
      currentOn: snapshot?.currentOn,
      stepId,
    })) {
      this.deps.debugStructured({
        event: 'stepped_load_feedback_ignored', reason: 'non_off_step_while_off', deviceName, stepId,
      });
      return 'unchanged';
    }
    const previousReportedStepId = this.runtimeState.steppedLoadReportedByDeviceId[deviceId]?.stepId;
    const previousDesired = this.runtimeState.steppedLoadDesiredByDeviceId[deviceId];
    const previousDesiredStepId = this.resolvePreviousDesiredStepId(profile, previousDesired);
    const latestPlanDesiredStepId = this.resolveLatestPlanDesiredStepId(deviceId, profile);
    const plannedDesiredStepId = latestPlanDesiredStepId ?? previousDesiredStepId;
    const changed = reportSteppedLoadActualStep({
      runtimeState: this.runtimeState,
      profiles: {
        ...storedProfiles,
        [deviceId]: profile,
      },
      deviceId,
      stepId,
    });

    const desiredStepToPreserve = this.resolvePlannedDesiredStepToPreserve({
      previousDesired,
      previousDesiredStepId,
      latestPlanDesiredStepId,
      plannedDesiredStepId,
      reportedStepId: stepId,
    });
    if (desiredStepToPreserve) {
      preserveSteppedLoadDesiredStep({
        runtimeState: this.runtimeState,
        deviceId,
        desiredStepId: desiredStepToPreserve,
        previousStepId: stepId,
        status: desiredStepToPreserve === stepId ? 'success' : 'idle',
      });
    }
    if (changed === 'unchanged') {
      this.deps.debugStructured({ event: 'stepped_load_feedback_unchanged', deviceName, stepId });
      return changed;
    }

    emitSteppedFeedbackLog({
      log: this.deps.getStructuredLogger('devices'),
      deviceId,
      deviceName,
      stepId,
      previousReportedStepId,
      previousDesired,
      plannedDesiredStepId,
    });
    return changed;
  }

  getRuntimeStateForTests(): DeviceControlRuntimeState {
    return this.runtimeState;
  }

  private resolveSteppedLoadFeedbackProfile(
    deviceId: string,
    snapshot: TargetDeviceSnapshot | undefined,
    storedProfiles: DeviceControlProfiles,
  ): SteppedLoadProfile | null {
    return resolveEffectiveSteppedLoadProfile({
      snapshot,
      profiles: storedProfiles,
      deviceId,
    });
  }

  private resolvePlannedDesiredStepToPreserve(params: {
    previousDesired: SteppedLoadDesiredRuntimeState | undefined;
    previousDesiredStepId: string | undefined;
    latestPlanDesiredStepId: string | undefined;
    plannedDesiredStepId: string | undefined;
    reportedStepId: string;
  }): string | undefined {
    const {
      previousDesired,
      previousDesiredStepId,
      latestPlanDesiredStepId,
      plannedDesiredStepId,
      reportedStepId,
    } = params;
    if (!plannedDesiredStepId) return undefined;
    if (latestPlanDesiredStepId && previousDesired && previousDesiredStepId !== latestPlanDesiredStepId) {
      return latestPlanDesiredStepId;
    }
    return !previousDesired && plannedDesiredStepId !== reportedStepId ? plannedDesiredStepId : undefined;
  }

  private resolvePreviousDesiredStepId(
    profile: SteppedLoadProfile,
    previousDesired: SteppedLoadDesiredRuntimeState | undefined,
  ): string | undefined {
    return getSteppedLoadStep(profile, previousDesired?.stepId)?.id;
  }

  private resolveLatestPlanDesiredStepId(deviceId: string, profile: SteppedLoadProfile): string | undefined {
    const plannedDevice = this.deps.getLatestPlanSnapshot?.()?.devices.find((device) => device.id === deviceId);
    return getSteppedLoadStep(
      profile,
      plannedDevice?.targetStepId ?? plannedDevice?.desiredStepId,
    )?.id;
  }
}
