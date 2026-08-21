import type { Logger } from '../lib/logging/logger';
import {
  buildEvTargetPowerProfileFingerprint,
  buildTargetPowerReachabilityState,
  isEvTargetPowerConfig,
  resolveEvTargetPowerConfirmedProfile,
  resolveEvTargetPowerExactStep,
  resolveEvTargetPowerExactStepById,
  resolveEvTargetPowerPlannerProfile,
  resolveValidTargetPowerReachability,
  withoutTargetPowerReachability,
} from '../lib/device/targetPowerReachability';
import { resolveTargetPowerReachabilityTransition } from '../lib/executor/targetPowerReachability';
import { LOCAL_STEPPED_LOAD_COMMAND_PENDING_MS } from '../lib/plan/planObservationPolicy';
import { sortSteppedLoadSteps } from '../lib/utils/deviceControlProfiles';
import type {
  ReportedStepObservedProbe,
  SteppedLoadDescriptorProbe,
  SteppedLoadProfile,
  SteppedLoadStep,
  TargetDeviceSnapshot,
  TargetPowerReachabilityState,
  TargetPowerSteppedLoadConfig,
} from '../packages/contracts/src/types';
import {
  confirmSteppedLoadDesiredStep,
  type DeviceControlRuntimeState,
  type SteppedLoadDesiredRuntimeState,
} from '../lib/executor/steppedCommandState';

type ReachabilitySnapshot = TargetDeviceSnapshot & SteppedLoadDescriptorProbe & ReportedStepObservedProbe;

type TargetPowerExactObservation = {
  planningPowerW: number;
  observedAtMs: number;
};

type IssuedTargetPowerDesired = SteppedLoadDesiredRuntimeState & {
  planningPowerW: number;
  lastIssuedAtMs: number;
  targetPowerProbeConfirmedMaxPowerW: number;
  targetPowerProbeStartedAtMs: number;
};

const resolveExactStepEvidence = (
  snapshot: ReachabilitySnapshot,
): TargetPowerExactObservation | undefined => {
  return typeof snapshot.reportedStepPowerW === 'number'
    && Number.isFinite(snapshot.reportedStepPowerW)
    && typeof snapshot.reportedStepObservedAtMs === 'number'
    && Number.isFinite(snapshot.reportedStepObservedAtMs)
    ? {
      planningPowerW: Math.round(snapshot.reportedStepPowerW),
      observedAtMs: snapshot.reportedStepObservedAtMs,
    }
    : undefined;
};

const persistObservedMaximum = (params: {
  config: TargetPowerSteppedLoadConfig;
  evidence: TargetPowerExactObservation;
  update: (reachability: TargetPowerReachabilityState) => boolean;
}): void => {
  if (params.evidence.planningPowerW <= 0) return;
  const current = resolveValidTargetPowerReachability(params.config);
  if (current && current.maxReachedPowerW >= params.evidence.planningPowerW) return;
  const next = buildTargetPowerReachabilityState({
    config: params.config,
    maxReachedPowerW: params.evidence.planningPowerW,
    probeFailureCount: current?.probeFailureCount,
    nextProbeAtMs: current?.nextProbeAtMs,
  });
  if (next) params.update(next);
};

const resolveIssuedDesired = (params: {
  snapshot: ReachabilitySnapshot;
  runtimeState: DeviceControlRuntimeState;
}): IssuedTargetPowerDesired | undefined => {
  const desired = params.runtimeState.steppedLoadDesiredByDeviceId.get(params.snapshot.id);
  if (
    !desired
    || desired.planningPowerW === undefined
    || desired.planningPowerW <= 0
    || desired.lastIssuedAtMs === undefined
    || desired.targetPowerProbeConfirmedMaxPowerW === undefined
    || desired.targetPowerProbeStartedAtMs === undefined
  ) {
    return undefined;
  }
  return desired as IssuedTargetPowerDesired;
};

const applyProbeTransition = (params: {
  snapshot: ReachabilitySnapshot;
  config: TargetPowerSteppedLoadConfig;
  evidence: TargetPowerExactObservation | undefined;
  desired: IssuedTargetPowerDesired;
  runtimeState: DeviceControlRuntimeState;
  nowMs: number;
  update: (reachability: TargetPowerReachabilityState) => boolean;
  logger?: Logger;
}): boolean => {
  const transition = resolveTargetPowerReachabilityTransition({
    profileFingerprint: buildEvTargetPowerProfileFingerprint(params.config),
    currentReachability: resolveValidTargetPowerReachability(params.config),
    command: {
      requestedPowerW: params.desired.planningPowerW,
      confirmedMaxPowerW: params.desired.targetPowerProbeConfirmedMaxPowerW,
      issuedAtMs: params.desired.targetPowerProbeStartedAtMs,
      settleWindowMs: params.desired.pendingWindowMs ?? LOCAL_STEPPED_LOAD_COMMAND_PENDING_MS,
    },
    observation: params.evidence,
    nowMs: params.nowMs,
  });
  if (transition.kind === 'waiting') return false;
  if (transition.kind === 'confirmed') {
    params.update(transition.reachability);
    confirmSteppedLoadDesiredStep({
      runtimeState: params.runtimeState,
      deviceId: params.snapshot.id,
      desired: params.desired,
    });
    params.logger?.info({
      event: 'target_power_reachability_raised',
      deviceId: params.snapshot.id,
      deviceName: params.snapshot.name,
      requestedPowerW: params.desired.planningPowerW,
      maxReachedPowerW: transition.reachability.maxReachedPowerW,
    });
    return true;
  }
  params.update(transition.reachability);
  params.runtimeState.steppedLoadDesiredByDeviceId.delete(params.snapshot.id);
  params.logger?.warn({
    event: 'target_power_step_settled_below_request',
    deviceId: params.snapshot.id,
    deviceName: params.snapshot.name,
    requestedStepId: params.desired.stepId,
    requestedPowerW: params.desired.planningPowerW,
    observedPowerW: transition.observedPowerW ?? null,
    maxReachedPowerW: transition.reachability.maxReachedPowerW,
    probeFailureCount: transition.reachability.probeFailureCount,
    nextProbeAtMs: transition.reachability.nextProbeAtMs,
  });
  return true;
};

const resolveTargetPowerFeedbackProfile = (params: {
  config: TargetPowerSteppedLoadConfig | undefined;
  baseProfile: SteppedLoadProfile | null;
  stepId: string;
  planningPowerW: number | undefined;
}): SteppedLoadProfile | null => {
  if (!params.baseProfile) return params.baseProfile;
  const exactStep = params.planningPowerW === undefined
    ? resolveEvTargetPowerExactStepById(params.config, params.stepId)
    : resolveEvTargetPowerExactStep(params.config, params.planningPowerW);
  if (!exactStep || params.baseProfile.steps.some((step: SteppedLoadStep) => step.id === exactStep.id)) {
    return params.baseProfile;
  }
  return { ...params.baseProfile, steps: sortSteppedLoadSteps([...params.baseProfile.steps, exactStep]) };
};

/** Canonicalize one Flow report, including an exact intermediate rung such as 25 A. */
export const resolveTargetPowerFeedbackReport = (params: {
  config: TargetPowerSteppedLoadConfig | undefined;
  baseProfile: SteppedLoadProfile | null;
  stepId: string;
  planningPowerW: number | undefined;
}): {
  profile: SteppedLoadProfile | null;
  reportState: {
    planningPowerW?: number;
  };
} => {
  const profile = resolveTargetPowerFeedbackProfile(params);
  return {
    profile,
    reportState: {
      planningPowerW: params.planningPowerW
        ?? profile?.steps.find((step) => step.id === params.stepId)?.planningPowerW,
    },
  };
};

/** Join accepted EV step commands with exact post-command feedback. */
export const reconcileTargetPowerReachability = (params: {
  snapshots: ReachabilitySnapshot[];
  runtimeState: DeviceControlRuntimeState;
  nowMs: number;
  getConfig: (deviceId: string) => TargetPowerSteppedLoadConfig | undefined;
  update: (deviceId: string, reachability: TargetPowerReachabilityState) => boolean;
  logger?: Logger;
}): void => {
  for (const snapshot of params.snapshots) {
    const config = params.getConfig(snapshot.id) ?? snapshot.targetPowerConfig;
    if (!isEvTargetPowerConfig(config)) continue;
    const evidence = resolveExactStepEvidence(snapshot);
    const update = (reachability: TargetPowerReachabilityState): boolean => (
      params.update(snapshot.id, reachability)
    );
    const desired = resolveIssuedDesired({ snapshot, runtimeState: params.runtimeState });
    if (desired && applyProbeTransition({ ...params, snapshot, config, evidence, desired, update })) continue;
    if (evidence) persistObservedMaximum({ config, evidence, update });
  }
};

export const resolveCurrentTargetPowerProfile = (params: {
  config: TargetPowerSteppedLoadConfig | undefined;
  fallback: SteppedLoadProfile | null;
  observedPowerW?: number;
}): SteppedLoadProfile | null => (
  isEvTargetPowerConfig(params.config)
    ? resolveEvTargetPowerConfirmedProfile(params.config, params.observedPowerW)
    : params.fallback
);

export const resolveIssuedTargetPowerStepPowers = (params: {
  config: TargetPowerSteppedLoadConfig | undefined;
  confirmedProfile: SteppedLoadProfile | null;
  desiredStepId: string;
  previousStepId?: string;
  issuedAtMs: number;
}): {
  planningPowerW?: number;
  previousPlanningPowerW?: number;
  targetPowerProbeConfirmedMaxPowerW?: number;
} => {
  if (!isEvTargetPowerConfig(params.config) || !params.confirmedProfile) return {};
  const profile = resolveEvTargetPowerPlannerProfile({
    config: params.config,
    confirmedProfile: params.confirmedProfile,
    nowMs: params.issuedAtMs,
  });
  const desiredPowerW = profile.steps.find((step) => step.id === params.desiredStepId)?.planningPowerW;
  const confirmedMaxPowerW = Math.max(...params.confirmedProfile.steps.map((step) => step.planningPowerW));
  return {
    planningPowerW: desiredPowerW,
    previousPlanningPowerW: profile.steps.find((step) => step.id === params.previousStepId)?.planningPowerW ?? 0,
    ...(desiredPowerW !== undefined && desiredPowerW > confirmedMaxPowerW
      ? { targetPowerProbeConfirmedMaxPowerW: confirmedMaxPowerW }
      : {}),
  };
};

export const resolveTargetPowerSnapshotProfiles = (params: {
  snapshots: ReachabilitySnapshot[];
  getConfig?: (deviceId: string) => TargetPowerSteppedLoadConfig | undefined;
  resolveFallbackProfile: (snapshot: ReachabilitySnapshot) => SteppedLoadProfile | null;
}): ReachabilitySnapshot[] => {
  return params.snapshots.map((snapshot) => {
    const config = params.getConfig?.(snapshot.id) ?? snapshot.targetPowerConfig;
    const evidence = isEvTargetPowerConfig(config)
      ? resolveExactStepEvidence(snapshot)
      : undefined;
    const profile = resolveCurrentTargetPowerProfile({
      config,
      fallback: params.resolveFallbackProfile(snapshot),
      observedPowerW: evidence?.planningPowerW,
    });
    if (!profile || !isEvTargetPowerConfig(config)) return snapshot;
    const exactStep = evidence
      ? resolveEvTargetPowerExactStep(config, evidence.planningPowerW)
      : undefined;
    return {
      ...snapshot,
      targetPowerConfig: withoutTargetPowerReachability(config),
      steppedLoadProfile: profile,
      suggestedSteppedLoadProfile: profile,
      ...(exactStep ? { reportedStepId: exactStep.id } : {}),
    };
  });
};
