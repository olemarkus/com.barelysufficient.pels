import {
  getSteppedLoadStep,
  hasUsableSteppedLoadLadder,
  isSteppedLoadOffStep,
} from '../lib/utils/deviceControlProfiles';
import { serializeLegacyStepFieldsFromEvidence } from '../lib/plan/planSteppedLoadState';
import { isNativeSteppedLoadControlEnabled } from '../lib/device/nativeSteppedLoadWiring';
import type {
  SteppedLoadCommandStatus,
  SteppedLoadProfile,
  TargetDeviceSnapshot,
} from '../packages/contracts/src/types';
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

// A native ladder still has to have a rung above zero to be stepped control at
// all — see `asSteppedLoadProfile` in `appDeviceControlHelpers.ts`.
export const resolveNativeSteppedLoadProfile = (snapshot: TargetDeviceSnapshot): SteppedLoadProfile | null => (
  isNativeSteppedLoadControlEnabled(snapshot)
    && snapshot.suggestedSteppedLoadProfile !== undefined
    && hasUsableSteppedLoadLadder(snapshot.suggestedSteppedLoadProfile)
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
  // A non-off flow report while the binary axis reads off is REAL telemetry, not a
  // contradiction to discard: a flow-backed charger announces the current it actually
  // came up at, and that announcement lands in the window between PELS writing the
  // binary on and the on-echo arriving (prod 2026-07-25, Easee "Elbillader" — 17-37 s
  // wide on that device, so every session-start report fell inside it). Dropping it
  // left the planner modelling a 6 A charger that was drawing 32 A. Flow reports are
  // now admitted on the same terms as native ones above; the binary axis still wins
  // the on/off fold (`resolveCurrentOn` is `!(binaryOff || steppedOff)`), so a non-off
  // observed step on an off device does not resurrect it.
  return {
    stepId: getSteppedLoadStep(params.profile, params.flowReportedStep?.stepId)?.id,
    source: 'flow',
    observedAtMs: params.flowReportedStep?.observedAtMs,
  };
}
