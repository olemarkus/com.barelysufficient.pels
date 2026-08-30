import {
  getSteppedLoadLowestActiveStep, getSteppedLoadStep,
  hasUsableSteppedLoadLadder,
  normalizeDeviceControlProfiles, resolveSteppedLoadPlanningPowerKw,
} from '../lib/utils/deviceControlProfiles';
import { resolveCurrentOn } from '../lib/observer/observedState';
import { isBinaryOnOrUnknown } from '../packages/shared-domain/src/binaryControlState';
import { isNativeSteppedLoadControlEnabled } from '../lib/device/nativeSteppedLoadWiring';
import type { Logger as PinoLogger, StructuredDebugEmitter } from '../lib/logging/logger';
import type { DevicePlan } from '../lib/plan/planTypes';
import { LOCAL_STEPPED_LOAD_COMMAND_PENDING_MS } from '../lib/plan/planObservationPolicy';
import type {
  DecoratedDeviceSnapshot, DeviceControlModel,
  DeviceControlProfiles, ReportedStepObservedProbe,
  SteppedLoadDescriptorProbe, SteppedLoadProfile,
  TargetDeviceSnapshot, TargetPowerReachabilityState,
  TargetPowerSteppedLoadConfig,
} from '../packages/contracts/src/types';
import type { LifecycleFallbackDevice } from '../lib/executor/lifecycleFallbackDispatcher';
import { projectLifecycleFallbackDevice } from './lifecycleFallbackDeviceProjection';
import { resolveTemperatureDeniedControlModel } from './temperatureControlDenial';
import {
  buildSteppedLoadSnapshotStepFields,
  resolveNativeSteppedLoadProfile,
} from './appDeviceControlSteppedState';
import {
  type DeviceControlRuntimeState,
  type MarkSteppedLoadDesiredStepIssuedParams,
  type ReportSteppedLoadActualStepResult,
} from '../lib/executor/steppedCommandState';
import type { SteppedCommandStore } from '../lib/executor/steppedCommandStore';
import {
  emitSteppedFeedbackLog,
  isValidSteppedLoadFeedbackProfile,
  resolveLatestPlanDesiredStepId,
  resolvePlannedDesiredStepToPreserve,
  resolvePreviousDesiredStepId,
} from './appDeviceControlFeedback';
import {
  resolveCurrentTargetPowerProfile,
  resolveIssuedTargetPowerStepPowers,
  reconcileTargetPowerReachability,
  resolveTargetPowerFeedbackReport,
  resolveTargetPowerSnapshotProfiles,
} from './appTargetPowerReachability';

// The stepped-load command runtime-state cluster lives in
// `lib/executor/steppedCommandState.ts`; re-exported here because this
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
} from '../lib/executor/steppedCommandState';
// The device's OWN attestation of its rung is an observation, so it is owned by
// the observer rather than by the command axis it gets reconciled against.
export { type SteppedLoadReportedRuntimeState } from '../lib/observer/steppedReportedStep';
export const normalizeStoredDeviceControlProfiles = normalizeDeviceControlProfiles;
const hasNativeSteppedLoadFeedbackAuthority = (
  snapshot: TargetDeviceSnapshot | undefined,
): boolean => snapshot !== undefined && isNativeSteppedLoadControlEnabled(snapshot);

export const resolveDefaultControlModel = (device: TargetDeviceSnapshot): DeviceControlModel => {
  if (device.controlModel) return device.controlModel;
  if (device.deviceType === 'temperature') return 'temperature_target';
  return 'binary_power';
};

/** Resolve command authority without treating an unrelated device as temperature-controlled. */
export const resolveTemperatureControlDisabled = (params: {
  policyState: 'unavailable' | 'resolved';
  disabledDevices: Readonly<Record<string, boolean>>;
  deviceId: string;
  device: TargetDeviceSnapshot | undefined;
}): boolean => (
  params.policyState === 'resolved'
    ? params.disabledDevices[params.deviceId] === true
    : params.device?.deviceType === 'temperature'
);

/**
 * A profile counts as stepped control only when it has a rung above zero.
 *
 * Having a profile at all is not enough: an empty or off-only ladder used to pass
 * here and pin `controlModel: 'stepped_load'` on the snapshot, after which every
 * consumer asking the ladder where to put the device got nothing back. Refusing
 * it lets `decorateSnapshotWithDeviceControl` fall through to
 * `resolveDefaultControlModel`, and a device with no other control axis drops
 * out of the snapshot upstream, exactly as one that loses `onoff` does.
 */
const asSteppedLoadProfile = (
  profile: SteppedLoadProfile | undefined,
): SteppedLoadProfile | null => (
  profile !== undefined && hasUsableSteppedLoadLadder(profile) ? profile : null
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
  const snapshotProfile = asSteppedLoadProfile(snapshot?.steppedLoadProfile);
  if (nativeProfile) return nativeProfile;
  if (snapshot?.targetPowerConfig && snapshotProfile) return snapshotProfile;
  if (storedProfile) return storedProfile;
  if (snapshotProfile) return snapshotProfile;
  return resolveSuggestedSteppedLoadProfile(snapshot);
};

/* eslint-disable complexity, max-statements --
 * Decoration resolves reported step state plus legacy planner fallback in one place.
 */
export const decorateSnapshotWithDeviceControl = (params: {
  // Owner seam: the input is a producer-fed transport snapshot carrying the
  // stepped-descriptor + reported-step probes; the decorator re-resolves the
  // effective profile and writes it (with `reportedStepId`) onto the carrier.
  snapshot: TargetDeviceSnapshot & SteppedLoadDescriptorProbe & ReportedStepObservedProbe;
  profiles: DeviceControlProfiles;
  store: SteppedCommandStore;
  temperatureControlDisabled?: boolean;
  nowMs?: number;
}): DecoratedDeviceSnapshot => {
  const {
    snapshot, profiles, store, temperatureControlDisabled = false, nowMs = Date.now(),
  } = params;
  // The denial is a stamp, not a demotion. The step cluster below is resolved
  // exactly as it is for any other device — the flag says nothing about a
  // ladder. Deliberately no command-state teardown here either:
  // `decorateTargetSnapshotList` is a mutating read run once per power sample,
  // so wiping the command axis from it would clear live state every few
  // seconds — no command would ever confirm, retry back-off would die, and the
  // lowest-step initialization latch would never latch. Stale state is already
  // covered by `pruneStaleSteppedLoadCommandStates` and
  // `expireConfirmedDesiredStepOnBinaryOff`.
  const temperatureDenial = temperatureControlDisabled
    ? { temperatureControlDisabled: true as const }
    : {};
  const nativeProfile = resolveNativeSteppedLoadProfile(snapshot);
  const profile = resolveEffectiveSteppedLoadProfile({
    snapshot,
    profiles,
    deviceId: snapshot.id,
  });
  if (!profile) {
    const defaultControlModel = resolveDefaultControlModel(snapshot);
    return {
      ...snapshot,
      ...temperatureDenial,
      controlModel: temperatureControlDisabled
        ? resolveTemperatureDeniedControlModel(defaultControlModel)
        : defaultControlModel,
    };
  }

  store.pruneStale(nowMs);
  const reported = store.getReported(snapshot.id);
  const nativeSteppedControlEnabled = nativeProfile !== null;
  const snapshotReportedStepId = getSteppedLoadStep(profile, snapshot.reportedStepId)?.id;
  const nativeReportedStepId = nativeSteppedControlEnabled ? snapshotReportedStepId : undefined;
  if (nativeSteppedControlEnabled && reported) {
    store.clearReported(snapshot.id);
  }
  const confirmedReportedStepId = nativeReportedStepId ?? snapshotReportedStepId;
  const observedStepId = nativeReportedStepId ?? reported?.stepId ?? snapshotReportedStepId;
  // One fold, one owner: the same `resolveCurrentOn` the decorated snapshot's
  // own `binaryControl.on` is built from, below. The setup-local twin this used
  // to call was that expression written twice — and the twin had drifted, since
  // it answered "unknown" where the canonical fold answers `true`.
  store.expireConfirmedDesiredOnBinaryOff(snapshot.id, resolveCurrentOn({
    binaryControl: snapshot.binaryControl,
    steppedLoadProfile: profile,
    selectedStepId: observedStepId,
  }));
  const desired = store.getDesired(snapshot.id);
  if (confirmedReportedStepId && desired?.stepId === confirmedReportedStepId) {
    store.confirmDesired(snapshot.id, desired);
  }
  const currentDesired = store.getDesired(snapshot.id);
  const fallbackStepId = getSteppedLoadLowestActiveStep(profile)?.id;
  store.resolveInitializationLatch(snapshot.id, fallbackStepId);
  const stepFields = buildSteppedLoadSnapshotStepFields({
    profile,
    nowMs,
    binaryOn: isBinaryOnOrUnknown(snapshot),
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
    ...temperatureDenial,
    controlModel: 'stepped_load',
    steppedLoadProfile: profile,
    reportedStepId: stepFields.reportedStepId,
    targetStepId: stepFields.targetStepId,
    selectedStepId,
    desiredStepId: stepFields.desiredStepId,
    previousStepId: currentDesired?.previousStepId,
    planningPowerKw,
    // The rung fold has ONE definition, and the observer owns it: a stepped
    // device is off when its binary axis reads off OR its selected rung is the
    // off step. The setup-local twin this used to call was the same expression
    // written twice, which is one edit away from two answers.
    binaryControl: {
      on: resolveCurrentOn({
        binaryControl: snapshot.binaryControl,
        steppedLoadProfile: profile,
        selectedStepId,
      }),
    },
    lastStepCommandIssuedAt: currentDesired?.lastIssuedAtMs,
    stepCommandRetryCount: currentDesired?.retryCount,
    nextStepCommandRetryAtMs: currentDesired?.nextRetryAtMs,
    stepCommandPending: currentDesired?.pending ?? false,
    stepCommandStatus: currentDesired?.status ?? 'idle',
  };
};
/* eslint-enable complexity */


export class AppDeviceControlHelpers {
  constructor(private readonly deps: {
    // The commanded axis is executor state; this class only reads and drives it
    // (`lib/executor/steppedCommandStore.ts`, `setup/AGENTS.md` § "No state").
    store: SteppedCommandStore;
    getProfiles: () => DeviceControlProfiles;
    getTargetPowerConfig?: (deviceId: string) => TargetPowerSteppedLoadConfig | undefined;
    updateTargetPowerReachability?: (deviceId: string, reachability: TargetPowerReachabilityState) => boolean;
    scheduleTargetPowerProbeSettlement?: (dueAtMs: number) => void;
    reportFlowSteppedLoadObservation?: (params: {
      deviceId: string;
      stepId: string;
      planningPowerW: number;
      observedAtMs: number;
    }) => boolean;
    isTemperatureControlDisabled?: (deviceId: string) => boolean;
    getDeviceSnapshots: () => Array<TargetDeviceSnapshot & SteppedLoadDescriptorProbe & ReportedStepObservedProbe>;
    getLatestPlanSnapshot?: () => DevicePlan | null;
    getStructuredLogger: (component: string) => PinoLogger | undefined;
    debugStructured: StructuredDebugEmitter;
  }) {}

  // No temperature-control gate: a ladder is the step axis, and the flag denies
  // only `target_temperature` writes. Gating here left the Overview card binary
  // for a flagged stepped device and starved its command session of a profile.
  getSteppedLoadProfile(deviceId: string): SteppedLoadProfile | null {
    const snapshot = this.deps.getDeviceSnapshots().find((device) => device.id === deviceId);
    const profile = resolveEffectiveSteppedLoadProfile({
      snapshot,
      profiles: this.deps.getProfiles(),
      deviceId,
    });
    if (snapshot) {
      const [resolved] = resolveTargetPowerSnapshotProfiles({
        snapshots: [snapshot],
        getConfig: this.deps.getTargetPowerConfig,
        resolveFallbackProfile: () => profile,
      });
      return resolveEffectiveSteppedLoadProfile({
        snapshot: resolved,
        profiles: this.deps.getProfiles(),
        deviceId,
      });
    }
    return resolveCurrentTargetPowerProfile({
      config: this.deps.getTargetPowerConfig?.(deviceId),
      fallback: profile,
    });
  }

  getLifecycleFallbackDevice(deviceId: string): LifecycleFallbackDevice | undefined {
    const snapshot = this.deps.getDeviceSnapshots().find((device) => device.id === deviceId);
    if (!snapshot) return undefined;
    const decorated = this.decorateTargetSnapshotList([snapshot])[0];
    if (!decorated) return undefined;
    return projectLifecycleFallbackDevice(decorated);
  }

  getSteppedLoadCommandSession(deviceId: string): {
    initializationAssumedStepId?: string;
    hasPriorStepCommand: boolean;
    reportedStepId?: string;
    stepCommandPending: boolean;
  } {
    const profile = this.getSteppedLoadProfile(deviceId);
    const lowestStepId = profile
      ? getSteppedLoadLowestActiveStep(profile)?.id
      : undefined;
    return {
      initializationAssumedStepId: this.deps.store.resolveInitializationLatch(deviceId, lowestStepId),
      hasPriorStepCommand: this.deps.store.hasPriorStepCommand(deviceId),
      reportedStepId: profile
        ? getSteppedLoadStep(
          profile,
          this.deps.store.getReported(deviceId)?.stepId,
        )?.id
        : undefined,
      // Whether a step command is in flight. Read from the commanded axis, not
      // from a decorated snapshot: the decoration is a once-per-cycle copy, and
      // drift asks this between cycles.
      stepCommandPending: this.deps.store.isStepCommandPending(deviceId),
    };
  }

  decorateTargetSnapshotList(
    snapshot: Array<TargetDeviceSnapshot & SteppedLoadDescriptorProbe & ReportedStepObservedProbe>,
  ): DecoratedDeviceSnapshot[] {
    const nowMs = Date.now();
    const profiles = this.deps.getProfiles();
    const resolvedSnapshots = resolveTargetPowerSnapshotProfiles({
      snapshots: snapshot,
      getConfig: this.deps.getTargetPowerConfig,
      resolveFallbackProfile: (device) => resolveEffectiveSteppedLoadProfile({
        snapshot: device,
        profiles,
        deviceId: device.id,
      }),
    });
    this.deps.store.pruneStale(nowMs);
    return resolvedSnapshots.map((device) => decorateSnapshotWithDeviceControl({
      snapshot: device,
      profiles,
      store: this.deps.store,
      temperatureControlDisabled: this.deps.isTemperatureControlDisabled?.(device.id) === true,
      nowMs,
    }));
  }

  markSteppedLoadDesiredStepIssued(params: MarkSteppedLoadDesiredStepIssuedParams): void {
    // An unacknowledged write arms no probe — see `unacknowledged` on the params
    // type. `targetPowerProbeConfirmedMaxPowerW` is the field that arms it
    // (`buildSteppedLoadPowerMetadata` stamps `targetPowerProbeStartedAtMs` only
    // when it is present), so drop exactly that one. The planning powers stay:
    // they are ordinary command metadata, and dropping them would change the
    // continuing-probe comparison for a later acknowledged retry of the step.
    const resolvedStepPowers = resolveIssuedTargetPowerStepPowers({
      config: this.deps.getTargetPowerConfig?.(params.deviceId),
      confirmedProfile: this.getSteppedLoadProfile(params.deviceId),
      desiredStepId: params.desiredStepId,
      previousStepId: params.previousStepId,
      issuedAtMs: params.issuedAtMs ?? Date.now(),
    });
    const {
      targetPowerProbeConfirmedMaxPowerW: _armsTheProbe,
      ...planningPowersOnly
    } = resolvedStepPowers;
    const stepPowers = params.unacknowledged === true
      ? planningPowersOnly
      : resolvedStepPowers;
    this.deps.store.markDesiredStepIssued({
      deviceId: params.deviceId,
      desiredStepId: params.desiredStepId,
      previousStepId: params.previousStepId,
      issuedAtMs: params.issuedAtMs,
      pendingWindowMs: params.pendingWindowMs,
      confirmationPolicy: params.confirmationPolicy,
      ...stepPowers,
    });
    const desired = this.deps.store.getDesired(params.deviceId);
    if (
      desired?.targetPowerProbeConfirmedMaxPowerW !== undefined
      && desired.targetPowerProbeStartedAtMs !== undefined
    ) {
      this.deps.scheduleTargetPowerProbeSettlement?.(
        desired.targetPowerProbeStartedAtMs
          + (desired.pendingWindowMs ?? LOCAL_STEPPED_LOAD_COMMAND_PENDING_MS),
      );
    }
  }

  hasPendingTargetPowerProbe(): boolean {
    return this.deps.store.hasPendingTargetPowerProbe();
  }

  reconcileTargetPowerReachability(
    snapshots = this.deps.getDeviceSnapshots(),
    nowMs = Date.now(),
  ): void {
    if (!this.deps.getTargetPowerConfig || !this.deps.updateTargetPowerReachability) return;
    reconcileTargetPowerReachability({
      snapshots,
      store: this.deps.store,
      nowMs,
      getConfig: this.deps.getTargetPowerConfig,
      update: this.deps.updateTargetPowerReachability,
      logger: this.deps.getStructuredLogger('devices'),
    });
  }

  reportSteppedLoadActualStep(
    deviceId: string,
    stepId: string,
    planningPowerW?: number,
  ): ReportSteppedLoadActualStepResult {
    const snapshot = this.deps.getDeviceSnapshots().find((device) => device.id === deviceId);
    const deviceName = snapshot ? snapshot.name.trim() : `device ${deviceId}`;
    // Per notes/logging/README.md: structured events keep `deviceId` for identity and
    // only carry `deviceName` when actually known (never an id-derived placeholder).
    const knownDeviceName = snapshot ? snapshot.name.trim() : undefined;
    if (hasNativeSteppedLoadFeedbackAuthority(snapshot)) {
      this.deps.store.clearReported(deviceId);
      this.deps.debugStructured({
        event: 'stepped_load_feedback_ignored', reason: 'native_wiring_enabled', deviceId, deviceName: knownDeviceName,
      });
      return 'unchanged';
    }
    const storedProfiles = this.deps.getProfiles();
    const baseProfile = this.resolveSteppedLoadFeedbackProfile(deviceId, snapshot, storedProfiles);
    const feedback = resolveTargetPowerFeedbackReport({
      config: this.deps.getTargetPowerConfig?.(deviceId),
      baseProfile,
      stepId,
      planningPowerW,
    });
    const { profile } = feedback;
    if (!isValidSteppedLoadFeedbackProfile(profile, stepId)) {
      this.deps.debugStructured({
        event: 'stepped_load_feedback_ignored', reason: 'invalid_step', deviceId, deviceName: knownDeviceName, stepId,
      });
      return 'invalid';
    }
    const previousReportedStepId = this.deps.store.getReported(deviceId)?.stepId;
    const previousDesired = this.deps.store.getDesired(deviceId);
    const previousDesiredStepId = resolvePreviousDesiredStepId(profile, previousDesired);
    const latestPlanDesiredStepId = resolveLatestPlanDesiredStepId({
      plan: this.deps.getLatestPlanSnapshot?.(),
      deviceId,
      profile,
    });
    const plannedDesiredStepId = latestPlanDesiredStepId ?? previousDesiredStepId;
    const reportedAtMs = Date.now();
    if (feedback.reportState.planningPowerW !== undefined) {
      this.deps.reportFlowSteppedLoadObservation?.({
        deviceId,
        stepId,
        planningPowerW: feedback.reportState.planningPowerW,
        observedAtMs: reportedAtMs,
      });
    }
    const changed = this.deps.store.reportActualStep({
      profiles: {
        ...storedProfiles,
        [deviceId]: profile,
      },
      deviceId,
      stepId,
      reportedAtMs,
      ...feedback.reportState,
    });
    this.reconcileTargetPowerReachability(snapshot ? [snapshot] : []);

    const desiredStepToPreserve = resolvePlannedDesiredStepToPreserve({
      previousDesired,
      previousDesiredStepId,
      latestPlanDesiredStepId,
      plannedDesiredStepId,
      reportedStepId: stepId,
    });
    if (desiredStepToPreserve) {
      this.deps.store.preserveDesiredStep({
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
    return this.deps.store.getStateForTests();
  }

  private resolveSteppedLoadFeedbackProfile(
    deviceId: string,
    snapshot: TargetDeviceSnapshot | undefined,
    storedProfiles: DeviceControlProfiles,
  ): SteppedLoadProfile | null {
    // Same axis rule as `getSteppedLoadProfile`: a flagged stepped device must
    // still learn which rung it reports, or its restored ladder never tracks.
    return resolveEffectiveSteppedLoadProfile({
      snapshot,
      profiles: storedProfiles,
      deviceId,
    });
  }

}
