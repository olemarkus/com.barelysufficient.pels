import {
  getSteppedLoadLowestActiveStep,
  getSteppedLoadStep,
  normalizeDeviceControlProfiles,
  resolveSteppedLoadPlanningPowerKw,
} from '../lib/utils/deviceControlProfiles';
import { isNativeSteppedLoadControlEnabled } from '../lib/device/nativeSteppedLoadWiring';
import type { Logger as PinoLogger, StructuredDebugEmitter } from '../lib/logging/logger';
import type { DevicePlan } from '../lib/plan/planTypes';
import type {
  DecoratedDeviceSnapshot,
  DeviceControlModel,
  DeviceControlProfiles,
  ReportedStepObservedProbe,
  SteppedLoadDescriptorProbe,
  SteppedLoadProfile,
  TargetDeviceSnapshot,
} from '../packages/contracts/src/types';
import {
  PELS_MEASURE_STEP_CAPABILITY_ID,
  PELS_TARGET_STEP_CAPABILITY_ID,
} from '../packages/shared-domain/src/steppedLoadSyntheticCapabilities';
import {
  buildSteppedLoadSnapshotStepFields,
  resolveNativeSteppedLoadProfile,
  resolveSteppedLoadCurrentOn,
  shouldSuppressSteppedLoadFlowReport,
} from './appDeviceControlSteppedState';
import {
  confirmSteppedLoadDesiredStep,
  expireConfirmedDesiredStepOnBinaryOff,
  markSteppedLoadDesiredStepIssued,
  preserveSteppedLoadDesiredStep,
  pruneStaleSteppedLoadCommandStates,
  reportSteppedLoadActualStep,
  type DeviceControlRuntimeState,
  type MarkSteppedLoadDesiredStepIssuedParams,
  type ReportSteppedLoadActualStepResult,
  type SteppedLoadDesiredRuntimeState,
  createDeviceControlRuntimeState,
} from './appDeviceControlSteppedCommandState';
import { emitSteppedFeedbackLog } from './appDeviceControlFeedback';
import { resolveBinaryOn } from '../lib/utils/binaryControl';

// The stepped-load command runtime-state cluster lives in
// `appDeviceControlSteppedCommandState.ts`; re-exported here because this
// module is the wiring surface app code and tests import from.
export {
  STEPPED_LOAD_COMMAND_STALE_MS,
  createDeviceControlRuntimeState,
  markSteppedLoadDesiredStepIssued,
  pruneStaleSteppedLoadCommandStates,
  reportSteppedLoadActualStep,
  type DeviceControlRuntimeState,
  type MarkSteppedLoadDesiredStepIssuedParams,
  type ReportSteppedLoadActualStepResult,
  type SteppedLoadDesiredRuntimeState,
  type SteppedLoadReportedRuntimeState,
} from './appDeviceControlSteppedCommandState';
export const normalizeStoredDeviceControlProfiles = normalizeDeviceControlProfiles;
export const resolveDefaultControlModel = (device: TargetDeviceSnapshot): DeviceControlModel => {
  if (device.controlModel) return device.controlModel;
  if (device.deviceType === 'temperature') return 'temperature_target';
  return 'binary_power';
};

/**
 * Pure deviceId → control-model map for the device-overview transition signature.
 *
 * CRITICAL: the RAW snapshot's `controlModel` is only ever `'stepped_load'` or
 * `undefined` (the producer sets it solely for stepped profiles —
 * `managerNativeEv.ts`); the full three-way model is derived from `deviceType`.
 * So this resolves EVERY device through `resolveDefaultControlModel` (not a bare
 * `device.controlModel` read) — otherwise the map stays empty for temperature /
 * on-off devices and a `temperature_target ↔ binary_power` flip never reaches the
 * signature. Pure (no device-manager access), so the caller can build it once per
 * overview pass off the cached `getSnapshot()` array without re-entering the SDK.
 */
export const buildControlModelMap = (
  devices: readonly TargetDeviceSnapshot[],
): Map<string, DeviceControlModel> => {
  const map = new Map<string, DeviceControlModel>();
  for (const device of devices) map.set(device.id, resolveDefaultControlModel(device));
  return map;
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
  // Owner-seam read of the producer-fed transport snapshot, which carries
  // `steppedLoadProfile` / `targetPowerConfig` via the descriptor probe (omitted
  // from the base type).
  snapshot?: TargetDeviceSnapshot & SteppedLoadDescriptorProbe;
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
  // Owner seam: the input is a producer-fed transport snapshot carrying the
  // stepped-descriptor + reported-step probes; the decorator re-resolves the
  // effective profile and writes it (with `reportedStepId`) onto the carrier.
  snapshot: TargetDeviceSnapshot & SteppedLoadDescriptorProbe & ReportedStepObservedProbe;
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
  expireConfirmedDesiredStepOnBinaryOff({
    runtimeState,
    deviceId: snapshot.id,
    observedOn: snapshot.binaryControl?.on,
  });

  const desired = runtimeState.steppedLoadDesiredByDeviceId.get(snapshot.id);
  const reported = runtimeState.steppedLoadReportedByDeviceId.get(snapshot.id);
  const nativeSteppedControlEnabled = nativeProfile !== null;
  const snapshotReportedStepId = getSteppedLoadStep(profile, snapshot.reportedStepId)?.id;
  const nativeReportedStepId = nativeSteppedControlEnabled ? snapshotReportedStepId : undefined;
  if (nativeSteppedControlEnabled && reported) {
    runtimeState.steppedLoadReportedByDeviceId.delete(snapshot.id);
  }
  const confirmedReportedStepId = nativeReportedStepId ?? snapshotReportedStepId;
  if (confirmedReportedStepId && desired?.stepId === confirmedReportedStepId) {
    confirmSteppedLoadDesiredStep({ runtimeState, deviceId: snapshot.id, desired });
  }
  const currentDesired = runtimeState.steppedLoadDesiredByDeviceId.get(snapshot.id);
  const fallbackStepId = getSteppedLoadLowestActiveStep(profile)?.id;
  const stepFields = buildSteppedLoadSnapshotStepFields({
    profile,
    nowMs,
    binaryOn: snapshot.binaryControl?.on ?? true,
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
    binaryControl: { on: resolveSteppedLoadCurrentOn({ snapshot, profile, selectedStepId }) },
    lastStepCommandIssuedAt: currentDesired?.lastIssuedAtMs,
    stepCommandRetryCount: currentDesired?.retryCount,
    nextStepCommandRetryAtMs: currentDesired?.nextRetryAtMs,
    stepCommandPending: currentDesired?.pending ?? false,
    stepCommandStatus: currentDesired?.status ?? 'idle',
  };
};
/* eslint-enable complexity */


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

  decorateTargetSnapshotList(
    snapshot: Array<TargetDeviceSnapshot & SteppedLoadDescriptorProbe & ReportedStepObservedProbe>,
  ): DecoratedDeviceSnapshot[] {
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
    // Per notes/logging/README.md: structured events keep `deviceId` for identity and
    // only carry `deviceName` when actually known (never an id-derived placeholder).
    const knownDeviceName = snapshot ? snapshot.name.trim() : undefined;
    if (snapshot && isNativeSteppedLoadControlEnabled(snapshot)) {
      this.runtimeState.steppedLoadReportedByDeviceId.delete(deviceId);
      this.deps.debugStructured({
        event: 'stepped_load_feedback_ignored', reason: 'native_wiring_enabled', deviceId, deviceName: knownDeviceName,
      });
      return 'unchanged';
    }
    const storedProfiles = this.deps.getProfiles();
    const profile = this.resolveSteppedLoadFeedbackProfile(deviceId, snapshot, storedProfiles);
    if (!profile || profile.model !== 'stepped_load' || !getSteppedLoadStep(profile, stepId)) {
      this.deps.debugStructured({
        event: 'stepped_load_feedback_ignored', reason: 'invalid_step', deviceId, deviceName: knownDeviceName, stepId,
      });
      return 'invalid';
    }
    const snapshotBinaryOn = snapshot ? resolveBinaryOn(snapshot) : undefined;
    if (shouldSuppressSteppedLoadFlowReport({
      profile,
      binaryOn: snapshotBinaryOn,
      stepId,
    })) {
      return this.handleSuppressedNonOffStepReport(deviceId, stepId, knownDeviceName);
    }
    const previousReportedStepId = this.runtimeState.steppedLoadReportedByDeviceId.get(deviceId)?.stepId;
    const previousDesired = this.runtimeState.steppedLoadDesiredByDeviceId.get(deviceId);
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
      this.deps.debugStructured({
        event: 'stepped_load_feedback_unchanged', deviceId, deviceName: knownDeviceName, stepId,
      });
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

  // A suppressed non-off report stays out of the OBSERVED axis (a fabricated
  // observed step while off would revive a dead shed-release path), but when it
  // matches the step PELS just commanded it IS the flow-transport confirmation
  // of that command — the analogue of a native capability echo. Dropping it
  // wholesale deadlocks flow-backed restore-from-off: the prepare-for-on step
  // can never confirm and the restore loops waiting_confirmation → stale →
  // retry_backoff forever (prod 2026-07-05 Elbillader).
  private handleSuppressedNonOffStepReport(
    deviceId: string,
    stepId: string,
    knownDeviceName: string | undefined,
  ): ReportSteppedLoadActualStepResult {
    const desired = this.runtimeState.steppedLoadDesiredByDeviceId.get(deviceId);
    if (desired && desired.stepId === stepId && desired.status !== 'success') {
      confirmSteppedLoadDesiredStep({
        runtimeState: this.runtimeState,
        deviceId,
        desired,
      });
      this.deps.getStructuredLogger('devices')?.info({
        event: 'stepped_load_command_confirmed_while_off',
        deviceId,
        deviceName: knownDeviceName,
        stepId,
        // Prior lifecycle state disambiguates prod logs: 'pending'/'stale' is a
        // real command echo; 'idle' is a plan-preserved step the report attests.
        previousStatus: desired.status,
        wasPending: desired.pending,
        measureCapabilityId: PELS_MEASURE_STEP_CAPABILITY_ID,
        targetCapabilityId: PELS_TARGET_STEP_CAPABILITY_ID,
      });
    } else if (desired && desired.stepId !== stepId && desired.status === 'success') {
      // The device attests a DIFFERENT non-off step than the confirmed one
      // (e.g. its current was raised externally while off). The stale
      // confirmation must lose to the fresher telemetry — but the conflicting
      // report confirms nothing itself and stays out of the observed axis.
      this.runtimeState.steppedLoadDesiredByDeviceId.set(deviceId, {
        ...desired,
        pending: false,
        status: 'idle',
      });
    }
    this.deps.debugStructured({
      event: 'stepped_load_feedback_ignored',
      reason: 'non_off_step_while_off',
      deviceId,
      deviceName: knownDeviceName,
      stepId,
    });
    return 'unchanged';
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
