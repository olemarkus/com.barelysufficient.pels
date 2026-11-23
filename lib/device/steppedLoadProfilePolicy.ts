import type {
  AutomaticPowerControl, PendingSteppedLoad, ReportedStepObservedProbe, SteppedLoadProfile,
} from '../../packages/contracts/src/types';
import { hasUsableSteppedLoadLadder } from '../../packages/shared-domain/src/deviceControlProfiles';

export type SteppedLoadProfileResolution = {
  steppedLoadProfile?: SteppedLoadProfile;
  pendingSteppedLoad?: PendingSteppedLoad;
  manualFlowSteppedLoad?: true;
};

/** Resolve the active ladder once, preserving phase geometry over saved nominal models. */
export function resolveSteppedLoadProfilePrecedence(
  chargingPhaseProfile: SteppedLoadProfile | undefined,
  nativeProfile: SteppedLoadProfile | undefined,
  targetPowerProfile: SteppedLoadProfile | undefined,
  savedFlowProfile: SteppedLoadProfile | undefined,
  flowSetup: PendingSteppedLoad['reason'] | 'ready',
): SteppedLoadProfileResolution {
  const builtInProfile = chargingPhaseProfile ?? nativeProfile ?? targetPowerProfile;
  if (builtInProfile) return { steppedLoadProfile: builtInProfile };
  if (!savedFlowProfile || !hasUsableSteppedLoadLadder(savedFlowProfile)) return {};
  return flowSetup === 'ready'
    ? { steppedLoadProfile: savedFlowProfile, manualFlowSteppedLoad: true }
    : { pendingSteppedLoad: { profile: savedFlowProfile, reason: flowSetup } };
}

export function resolveReportedStep(
  phaseProfile: SteppedLoadProfile | undefined,
  native: ReportedStepObservedProbe,
  target: ReportedStepObservedProbe,
): ReportedStepObservedProbe {
  const reportedStepId = native.reportedStepId ?? target.reportedStepId;
  const phaseStep = phaseProfile?.steps.find((step) => step.id === reportedStepId);
  return {
    reportedStepId,
    reportedStepPowerW: phaseStep?.planningPowerW ?? target.reportedStepPowerW ?? native.reportedStepPowerW,
    reportedStepObservedAtMs: target.reportedStepPowerW !== undefined
      ? target.reportedStepObservedAtMs : native.reportedStepObservedAtMs,
  };
}

export function readInstallationTargetWatts(
  control: AutomaticPowerControl | undefined, isInstallationMain: boolean,
  reportedStepId: string | undefined, watts: unknown,
): number | undefined {
  return control?.mode === 'automatic' && isInstallationMain && reportedStepId !== undefined
    && typeof watts === 'number' && Number.isFinite(watts) && watts >= 0
    ? watts : undefined;
}
