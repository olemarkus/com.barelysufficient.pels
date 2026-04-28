import {
  getSteppedLoadStep,
} from '../utils/deviceControlProfiles';
import type { SteppedLoadProfile, TargetDeviceSnapshot } from '../utils/types';

type DecoratedSteppedLoadState = {
  reportedStepId?: string;
  targetStepId?: string;
  selectedStepId?: string;
  assumedStepId?: string;
  restorePreparedStepId?: string;
  actualStepId?: string;
  actualStepSource?: 'reported' | 'assumed';
};

const isNonOffSteppedLoadStep = (profile: SteppedLoadProfile, stepId?: string): boolean => {
  const step = getSteppedLoadStep(profile, stepId);
  return step !== null && step.planningPowerW > 0 && step.id !== 'off';
};

const resolveSteppedLoadActualStepSource = (params: {
  reportedStepId?: string;
  assumedStepId?: string;
}): 'reported' | 'assumed' | undefined => {
  const { reportedStepId, assumedStepId } = params;
  if (reportedStepId) return 'reported';
  if (assumedStepId) return 'assumed';
  return undefined;
};

const resolveRestorePreparedStepId = (params: {
  profile: SteppedLoadProfile;
  suppressedFlowStepId?: string;
  targetStepId?: string;
  fallbackStepId?: string;
}): string | undefined => {
  const {
    profile,
    suppressedFlowStepId,
    targetStepId,
    fallbackStepId,
  } = params;
  if (!isNonOffSteppedLoadStep(profile, suppressedFlowStepId)) return undefined;
  const restoreStepId = targetStepId ?? fallbackStepId;
  return restoreStepId === suppressedFlowStepId ? suppressedFlowStepId : undefined;
};

export const resolveDecoratedSteppedLoadState = (params: {
  snapshot: TargetDeviceSnapshot;
  profile: SteppedLoadProfile;
  nativeReportedStepId?: string;
  flowReportedStepId?: string;
  targetStepId?: string;
  fallbackStepId?: string;
}): DecoratedSteppedLoadState => {
  const {
    snapshot,
    profile,
    nativeReportedStepId,
    flowReportedStepId,
    targetStepId,
    fallbackStepId,
  } = params;
  const suppressedFlowStepId = snapshot.currentOn === false
    && !nativeReportedStepId
    && isNonOffSteppedLoadStep(profile, flowReportedStepId)
    ? flowReportedStepId
    : undefined;
  const reportedStepId = nativeReportedStepId ?? (
    suppressedFlowStepId ? undefined : flowReportedStepId
  );
  const restorePreparedStepId = resolveRestorePreparedStepId({
    profile,
    suppressedFlowStepId,
    targetStepId,
    fallbackStepId,
  });
  const assumedStepId = reportedStepId || restorePreparedStepId ? undefined : fallbackStepId;
  const selectedStepId = reportedStepId ?? restorePreparedStepId ?? assumedStepId;
  const actualStepId = reportedStepId;
  const actualStepSource = resolveSteppedLoadActualStepSource({ reportedStepId, assumedStepId });

  return {
    reportedStepId,
    targetStepId,
    selectedStepId,
    assumedStepId,
    restorePreparedStepId,
    actualStepId,
    actualStepSource,
  };
};
