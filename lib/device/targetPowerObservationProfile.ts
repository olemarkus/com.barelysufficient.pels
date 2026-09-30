import type {
  SteppedLoadProfile, SteppedLoadStep, TargetPowerSteppedLoadConfig,
} from '../../packages/contracts/src/types';
import { sortSteppedLoadSteps } from '../../packages/shared-domain/src/deviceControlProfiles';
import { resolveEvTargetPowerConfirmedProfile } from './targetPowerReachability';

/** A device-admitted exact EV rung advances its confirmed ladder. */
export function resolveTargetPowerObservationProfile(
  config: TargetPowerSteppedLoadConfig,
  confirmedProfile: SteppedLoadProfile,
  exactStep: SteppedLoadStep,
): SteppedLoadProfile {
  const confirmedMaxPowerW = Math.max(
    exactStep.planningPowerW, ...confirmedProfile.steps.map((step) => step.planningPowerW),
  );
  const profile = resolveEvTargetPowerConfirmedProfile(config, confirmedMaxPowerW);
  return profile.steps.some((step) => step.id === exactStep.id)
    ? profile : { ...profile, steps: sortSteppedLoadSteps([...profile.steps, exactStep]) };
}
