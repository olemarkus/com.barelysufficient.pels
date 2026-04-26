import {
  getSteppedLoadLowestActiveStep,
  getSteppedLoadStep,
  isSteppedLoadOffStep,
  normalizeDeviceControlProfiles,
  resolveSteppedLoadPlanningPowerKw,
} from '../utils/deviceControlProfiles';
import { isNativeSteppedLoadControlEnabled } from '../core/nativeSteppedLoadWiring';
import type { Logger as PinoLogger } from '../logging/logger';
import type { DevicePlan } from '../plan/planTypes';
import type {
  DeviceControlModel,
  DeviceControlProfiles,
  SteppedLoadCommandStatus,
  SteppedLoadProfile,
  TargetDeviceSnapshot,
} from '../utils/types';
import { STEPPED_LOAD_COMMAND_RETRY_DELAYS_MS } from '../plan/planConstants';
import { LOCAL_STEPPED_LOAD_COMMAND_PENDING_MS } from '../plan/planObservationPolicy';
import {
  PELS_MEASURE_STEP_CAPABILITY_ID,
  PELS_TARGET_STEP_CAPABILITY_ID,
} from '../core/steppedLoadSyntheticCapabilities';

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

const resolveNativeSteppedLoadProfile = (snapshot: TargetDeviceSnapshot): SteppedLoadProfile | null => (
  isNativeSteppedLoadControlEnabled(snapshot) && snapshot.suggestedSteppedLoadProfile?.model === 'stepped_load'
    ? snapshot.suggestedSteppedLoadProfile
    : null
);

const resolveSteppedLoadActualStepSource = (params: {
  reportedStepId?: string;
  assumedStepId?: string;
}): 'reported' | 'assumed' | undefined => {
  const { reportedStepId, assumedStepId } = params;
  if (reportedStepId) return 'reported';
  if (assumedStepId) return 'assumed';
  return undefined;
};

const resolveSteppedLoadCurrentOn = (params: {
  snapshot: TargetDeviceSnapshot;
  profile: SteppedLoadProfile;
  selectedStepId?: string;
}): boolean => {
  const { snapshot, profile, selectedStepId } = params;
  if (snapshot.currentOn === false) return false;
  if (!selectedStepId) return true;
  return !isSteppedLoadOffStep(profile, selectedStepId);
};

/* eslint-disable complexity --
 * Decoration resolves reported step state plus legacy planner fallback in one place.
 */
export const decorateSnapshotWithDeviceControl = (params: {
  snapshot: TargetDeviceSnapshot;
  profiles: DeviceControlProfiles;
  runtimeState: DeviceControlRuntimeState;
  nowMs?: number;
}): TargetDeviceSnapshot => {
  const { snapshot, profiles, runtimeState, nowMs = Date.now() } = params;
  const nativeProfile = resolveNativeSteppedLoadProfile(snapshot);
  const storedProfile = profiles[snapshot.id];
  const profile = nativeProfile ?? (storedProfile?.model === 'stepped_load' ? storedProfile : null);
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
  const nativeReportedStepId = nativeSteppedControlEnabled
    ? getSteppedLoadStep(profile, snapshot.reportedStepId)?.id
    : undefined;
  if (nativeSteppedControlEnabled && reported) {
    /* eslint-disable-next-line functional/immutable-data -- Shared stepped-load runtime cache update. */
    delete runtimeState.steppedLoadReportedByDeviceId[snapshot.id];
  }
  if (nativeReportedStepId && desired?.stepId === nativeReportedStepId) {
    /* eslint-disable-next-line functional/immutable-data -- Shared stepped-load runtime cache update. */
    runtimeState.steppedLoadDesiredByDeviceId[snapshot.id] = {
      ...desired,
      retryCount: 0,
      nextRetryAtMs: undefined,
      pending: false,
      status: 'success',
    };
  }
  const reportedStepId = nativeSteppedControlEnabled
    ? nativeReportedStepId
    : getSteppedLoadStep(profile, reported?.stepId)?.id;
  const desiredStepId = getSteppedLoadStep(profile, desired?.stepId)?.id;
  const fallbackStepId = getSteppedLoadLowestActiveStep(profile)?.id;
  const assumedStepId = reportedStepId ? undefined : fallbackStepId;
  const selectedStepId = reportedStepId ?? assumedStepId;
  const actualStepId = reportedStepId;
  const actualStepSource = resolveSteppedLoadActualStepSource({ reportedStepId, assumedStepId });
  const planningPowerKw = resolveSteppedLoadPlanningPowerKw(profile, selectedStepId);

  return {
    ...snapshot,
    controlModel: 'stepped_load',
    steppedLoadProfile: profile,
    reportedStepId,
    targetStepId: desiredStepId,
    selectedStepId,
    desiredStepId,
    previousStepId: desired?.previousStepId,
    actualStepId,
    assumedStepId,
    actualStepSource,
    planningPowerKw,
    // Preserve an explicit off state from the raw onoff capability for stepped devices. A device
    // at a non-zero step but with onoff=false is genuinely off — the step is configuration, not
    // power state. An explicit on state may still be overridden by an off-step selection.
    currentOn: resolveSteppedLoadCurrentOn({ snapshot, profile, selectedStepId }),
    lastDesiredStepChangeAt: desired?.changedAtMs,
    lastStepCommandIssuedAt: desired?.lastIssuedAtMs,
    stepCommandRetryCount: desired?.retryCount,
    nextStepCommandRetryAtMs: desired?.nextRetryAtMs,
    stepCommandPending: desired?.pending ?? false,
    stepCommandStatus: desired?.status ?? 'idle',
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
    logDebug: (topic: 'devices', ...args: unknown[]) => void;
  }) {}

  getSteppedLoadProfile(deviceId: string): SteppedLoadProfile | null {
    const snapshot = this.deps.getDeviceSnapshots().find((device) => device.id === deviceId);
    if (snapshot) {
      const nativeProfile = resolveNativeSteppedLoadProfile(snapshot);
      if (nativeProfile) return nativeProfile;
    }
    const profile = this.deps.getProfiles()[deviceId];
    return profile?.model === 'stepped_load' ? profile : null;
  }

  decorateTargetSnapshotList(snapshot: TargetDeviceSnapshot[]): TargetDeviceSnapshot[] {
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
      this.deps.logDebug('devices', `Stepped load feedback ignored for ${deviceName}: native wiring is enabled`);
      return 'unchanged';
    }
    const previousReportedStepId = this.runtimeState.steppedLoadReportedByDeviceId[deviceId]?.stepId;
    const previousDesired = this.runtimeState.steppedLoadDesiredByDeviceId[deviceId];
    const previousDesiredStepId = this.resolvePreviousDesiredStepId(deviceId, previousDesired);
    const latestPlanDesiredStepId = this.resolveLatestPlanDesiredStepId(deviceId);
    const plannedDesiredStepId = latestPlanDesiredStepId ?? previousDesiredStepId;
    const changed = reportSteppedLoadActualStep({
      runtimeState: this.runtimeState,
      profiles: this.deps.getProfiles(),
      deviceId,
      stepId,
    });

    if (changed === 'invalid') {
      this.deps.logDebug('devices', `Stepped load feedback ignored for ${deviceName}: invalid step '${stepId}'`);
      return changed;
    }
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
      this.deps.logDebug('devices', `Stepped load feedback unchanged for ${deviceName}: ${stepId}`);
      return changed;
    }

    this.emitSteppedFeedbackLog({
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

  /* eslint-disable-next-line complexity -- Feedback logging maps mutually exclusive runtime states to stable events. */
  private emitSteppedFeedbackLog(params: {
    deviceId: string;
    deviceName: string;
    stepId: string;
    previousReportedStepId: string | undefined;
    previousDesired: SteppedLoadDesiredRuntimeState | undefined;
    plannedDesiredStepId: string | undefined;
  }): void {
    const {
      deviceId,
      deviceName,
      stepId,
      previousReportedStepId,
      previousDesired,
      plannedDesiredStepId,
    } = params;
    const log = this.deps.getStructuredLogger('devices');
    if (previousDesired?.stepId === stepId) {
      log?.info({
        event: 'stepped_feedback_confirmed',
        deviceId,
        deviceName,
        measureCapabilityId: PELS_MEASURE_STEP_CAPABILITY_ID,
        targetCapabilityId: PELS_TARGET_STEP_CAPABILITY_ID,
        reportedStepId: stepId,
        desiredStepId: previousDesired.stepId,
        pending: previousDesired.pending,
        stale: previousDesired.status === 'stale',
      });
    } else if (plannedDesiredStepId === stepId) {
      log?.info({
        event: 'stepped_feedback_confirmed',
        deviceId,
        deviceName,
        measureCapabilityId: PELS_MEASURE_STEP_CAPABILITY_ID,
        targetCapabilityId: PELS_TARGET_STEP_CAPABILITY_ID,
        reportedStepId: stepId,
        desiredStepId: plannedDesiredStepId,
        pending: previousDesired?.pending ?? false,
        stale: previousDesired?.status === 'stale',
      });
    } else if (plannedDesiredStepId && plannedDesiredStepId !== stepId) {
      log?.info({
        event: 'stepped_feedback_mismatch',
        deviceId,
        deviceName,
        measureCapabilityId: PELS_MEASURE_STEP_CAPABILITY_ID,
        targetCapabilityId: PELS_TARGET_STEP_CAPABILITY_ID,
        reportedStepId: stepId,
        desiredStepId: plannedDesiredStepId,
      });
    } else if (previousReportedStepId && previousReportedStepId !== stepId) {
      log?.info({
        event: 'stepped_feedback_external_change',
        deviceId,
        deviceName,
        measureCapabilityId: PELS_MEASURE_STEP_CAPABILITY_ID,
        targetCapabilityId: PELS_TARGET_STEP_CAPABILITY_ID,
        previousStepId: previousReportedStepId,
        newStepId: stepId,
        desiredStepId: previousDesired?.stepId ?? null,
      });
    } else if (previousDesired?.stepId && previousDesired.stepId !== stepId) {
      log?.info({
        event: 'stepped_feedback_mismatch',
        deviceId,
        deviceName,
        measureCapabilityId: PELS_MEASURE_STEP_CAPABILITY_ID,
        targetCapabilityId: PELS_TARGET_STEP_CAPABILITY_ID,
        reportedStepId: stepId,
        desiredStepId: previousDesired.stepId,
      });
    } else {
      log?.info({
        event: 'stepped_feedback_reported',
        deviceId,
        deviceName,
        measureCapabilityId: PELS_MEASURE_STEP_CAPABILITY_ID,
        reportedStepId: stepId,
      });
    }
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
    deviceId: string,
    previousDesired: SteppedLoadDesiredRuntimeState | undefined,
  ): string | undefined {
    const profile = this.deps.getProfiles()[deviceId];
    if (!profile || profile.model !== 'stepped_load') return undefined;

    return getSteppedLoadStep(profile, previousDesired?.stepId)?.id;
  }

  private resolveLatestPlanDesiredStepId(deviceId: string): string | undefined {
    const profile = this.deps.getProfiles()[deviceId];
    if (!profile || profile.model !== 'stepped_load') return undefined;

    const plannedDevice = this.deps.getLatestPlanSnapshot?.()?.devices.find((device) => device.id === deviceId);
    return getSteppedLoadStep(
      profile,
      plannedDevice?.targetStepId ?? plannedDevice?.desiredStepId,
    )?.id;
  }
}
