import type { SteppedLoadProfile } from '../../packages/contracts/src/types';
import { hasUsableSteppedLoadLadder } from '../../packages/shared-domain/src/deviceControlProfiles';

/** Resolve the active ladder once, preserving phase geometry over saved nominal models. */
export function resolveSteppedLoadProfilePrecedence(
  chargingPhaseProfile: SteppedLoadProfile | undefined,
  nativeProfile: SteppedLoadProfile | undefined,
  targetPowerProfile: SteppedLoadProfile | undefined,
  savedFlowProfile: SteppedLoadProfile | undefined,
): SteppedLoadProfile | undefined {
  return chargingPhaseProfile ?? nativeProfile ?? targetPowerProfile
    ?? (hasUsableSteppedLoadLadder(savedFlowProfile) ? savedFlowProfile : undefined);
}

