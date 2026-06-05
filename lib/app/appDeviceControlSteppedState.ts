import { getSteppedLoadStep, isSteppedLoadOffStep } from '../utils/deviceControlProfiles';
import { serializeLegacyStepFieldsFromEvidence } from '../plan/planSteppedLoadState';
import { isNativeSteppedLoadControlEnabled } from '../device/nativeSteppedLoadWiring';
import type {
  DeviceControlProfile,
  SteppedLoadCommandStatus,
  SteppedLoadProfile,
  TargetDeviceSnapshot,
} from '../../packages/contracts/src/types';
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

type SteppedLoadStepFields = {
  reportedStepId?: string;
  targetStepId?: string;
  desiredStepId?: string;
  selectedStepId?: string;
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
  if (snapshot.binaryControl?.on === false) return false;
  if (!selectedStepId) return true;
  return !isSteppedLoadOffStep(profile, selectedStepId);
};

export function buildSteppedLoadSnapshotStepFields(params: {
  profile: SteppedLoadProfile;
  nowMs: number;
  binaryOn?: boolean;
  nativeSteppedControlEnabled: boolean;
  nativeReportedStep?: StepEvidence;
  flowReportedStep?: StepEvidence;
  targetStep?: TargetStepEvidence;
  fallbackStepId?: string;
}): SteppedLoadStepFields {
  const reportedStep = resolveReportedStepEvidence({
    profile: params.profile,
    binaryOn: params.binaryOn,
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
  binaryOn?: boolean;
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
      binaryOn: params.binaryOn,
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
  binaryOn?: boolean;
  stepId?: string;
}): boolean {
  return shouldSuppressSteppedLoadFlowReport(params);
}

export function shouldSuppressSteppedLoadFlowReport(params: {
  profile?: DeviceControlProfile;
  binaryOn?: boolean;
  stepId?: string;
}): boolean {
  if (params.profile?.model !== 'stepped_load') return false;
  if (!params.stepId) return false;
  if (params.binaryOn !== false) return false;
  return !isSteppedLoadOffStep(params.profile, params.stepId);
}
