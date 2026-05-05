import { getSteppedLoadStep, isSteppedLoadOffStep } from '../utils/deviceControlProfiles';
import { serializeLegacyStepFieldsFromEvidence } from '../plan/planSteppedLoadState';
import { isNativeSteppedLoadControlEnabled } from '../core/nativeSteppedLoadWiring';
import type {
  DeviceControlProfile,
  SteppedLoadActualStepSource,
  SteppedLoadCommandStatus,
  SteppedLoadProfile,
  TargetDeviceSnapshot,
} from '../utils/types';

type StepEvidence = {
  stepId?: string;
  observedAtMs?: number;
};

type TargetStepEvidence = {
  stepId?: string;
  changedAtMs?: number;
  status?: SteppedLoadCommandStatus;
};

type ReportedStepEvidence = {
  stepId?: string;
  source: 'native' | 'flow';
  observedAtMs?: number;
};

type LegacyStepFields = {
  reportedStepId?: string;
  targetStepId?: string;
  desiredStepId?: string;
  selectedStepId?: string;
  actualStepId?: string;
  assumedStepId?: string;
  actualStepSource?: SteppedLoadActualStepSource;
  restorePreparedStepId?: string;
};

export const resolveNativeSteppedLoadProfile = (snapshot: TargetDeviceSnapshot): SteppedLoadProfile | null => (
  isNativeSteppedLoadControlEnabled(snapshot) && snapshot.suggestedSteppedLoadProfile?.model === 'stepped_load'
    ? snapshot.suggestedSteppedLoadProfile
    : null
);

export const resolveSteppedLoadCurrentOn = (params: {
  snapshot: TargetDeviceSnapshot;
  profile: SteppedLoadProfile;
  selectedStepId?: string;
}): boolean => {
  const { snapshot, profile, selectedStepId } = params;
  if (snapshot.currentOn === false) return false;
  if (!selectedStepId) return true;
  return !isSteppedLoadOffStep(profile, selectedStepId);
};

export function buildSteppedLoadSnapshotStepFields(params: {
  profile: SteppedLoadProfile;
  nowMs: number;
  currentOn?: boolean;
  nativeSteppedControlEnabled: boolean;
  nativeReportedStep?: StepEvidence;
  flowReportedStep?: StepEvidence;
  targetStep?: TargetStepEvidence;
  fallbackStepId?: string;
}): LegacyStepFields {
  const reportedStep = resolveReportedStepEvidence({
    profile: params.profile,
    currentOn: params.currentOn,
    nativeSteppedControlEnabled: params.nativeSteppedControlEnabled,
    nativeReportedStep: params.nativeReportedStep,
    flowReportedStep: params.flowReportedStep,
  });
  const targetStepId = getSteppedLoadStep(params.profile, params.targetStep?.stepId)?.id;

  return serializeLegacyStepFieldsFromEvidence({
    nowMs: params.nowMs,
    reportedStepId: reportedStep.stepId,
    reportedStepSource: reportedStep.source,
    reportedObservedAtMs: reportedStep.observedAtMs,
    targetStepId,
    targetChangedAtMs: params.targetStep?.changedAtMs,
    targetStatus: params.targetStep?.status,
    fallbackStepId: params.fallbackStepId,
  });
}

function resolveReportedStepEvidence(params: {
  profile: SteppedLoadProfile;
  currentOn?: boolean;
  nativeSteppedControlEnabled: boolean;
  nativeReportedStep?: StepEvidence;
  flowReportedStep?: StepEvidence;
}): ReportedStepEvidence {
  if (params.nativeSteppedControlEnabled) {
    return {
      stepId: getSteppedLoadStep(params.profile, params.nativeReportedStep?.stepId)?.id,
      source: 'native',
      observedAtMs: params.nativeReportedStep?.observedAtMs,
    };
  }
  const flowStepId = getSteppedLoadStep(params.profile, params.flowReportedStep?.stepId)?.id;
  return {
    stepId: shouldSuppressFlowReport({
      profile: params.profile,
      currentOn: params.currentOn,
      stepId: flowStepId,
    })
      ? undefined
      : flowStepId,
    source: 'flow',
    observedAtMs: params.flowReportedStep?.observedAtMs,
  };
}

function shouldSuppressFlowReport(params: {
  profile: SteppedLoadProfile;
  currentOn?: boolean;
  stepId?: string;
}): boolean {
  return shouldSuppressSteppedLoadFlowReport(params);
}

export function shouldSuppressSteppedLoadFlowReport(params: {
  profile?: DeviceControlProfile;
  currentOn?: boolean;
  stepId?: string;
}): boolean {
  if (params.profile?.model !== 'stepped_load') return false;
  if (!params.stepId) return false;
  if (params.currentOn !== false) return false;
  return !isSteppedLoadOffStep(params.profile, params.stepId);
}
