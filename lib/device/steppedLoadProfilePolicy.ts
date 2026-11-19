import type { PendingSteppedLoad, SteppedLoadProfile } from '../../packages/contracts/src/types';
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

