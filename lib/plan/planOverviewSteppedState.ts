import type { DeviceOverviewSteppedLoad } from '../../packages/shared-domain/src/deviceOverview';
import type { SteppedLoadProfile } from '../../packages/contracts/src/types';
import { getSteppedLoadHighestStep, getSteppedLoadStep } from '../utils/deviceControlProfiles';
import { isSteppedLoadDevice } from './planSteppedLoad';
import type { DevicePlanDevice } from './planTypes';

/**
 * Builds the overview shape's stepped cluster from a plan device — the ONE
 * place either carrier of `DeviceOverviewSnapshot` answers "is this device
 * stepped, and at which step".
 *
 * It lives in its own module rather than inside either carrier because both
 * need it: the settings read model (`settingsOverviewReadModel`) for the card,
 * and the overview log/signature seam (`planOverviewEmit`) for the device log.
 * Those two used to reconstruct a `controlModel` setting apiece, with different
 * ladders, and the same device could come out stepped on one surface and binary
 * on the other. Presence of this cluster is now the discriminant on both.
 *
 * `confirmedProfile` is the settings-UI's confirmed (reachability-trimmed)
 * ladder when the caller has one; the log seam has none and passes nothing, in
 * which case the device's own profile is the answer.
 */
// Where the device actually is, for when the planner's target is not a step of
// the confirmed ladder.
function resolveObservedStepId(
  profile: SteppedLoadProfile,
  reportedStepId: string | null,
): string | null {
  return getSteppedLoadStep(profile, reportedStepId ?? undefined)?.id
    ?? getSteppedLoadHighestStep(profile)?.id
    ?? null;
}

function hasPendingStepCommand(device: DevicePlanDevice): boolean {
  return device.binaryCommandPending === true
    || device.stepCommandPending === true
    || device.pendingTargetCommand != null;
}

export function buildOverviewSteppedLoad(
  device: DevicePlanDevice,
  confirmedProfile?: SteppedLoadProfile,
): DeviceOverviewSteppedLoad | undefined {
  if (!isSteppedLoadDevice(device)) return undefined;
  const profile = confirmedProfile ?? device.steppedLoadProfile;
  const reportedStepId = device.reportedStepId ?? null;
  const plannedTargetStepId = device.targetStepId ?? device.desiredStepId ?? null;
  // A planner target that is not a step of the CONFIRMED ladder is a planner-only
  // intent (the ladder was trimmed under it); show where the device actually is
  // instead, and do not present a pending command the owner cannot see land.
  const plannerOnlyTarget = confirmedProfile !== undefined
    && plannedTargetStepId !== null
    && getSteppedLoadStep(confirmedProfile, plannedTargetStepId) === null;
  return {
    profile,
    reportedStepId,
    targetStepId: plannerOnlyTarget
      ? resolveObservedStepId(profile, reportedStepId)
      : plannedTargetStepId,
    // Read straight off the narrowed stepped device: both are REQUIRED on
    // `SteppedLoadKind`, so there is nothing to resolve here. They used to
    // travel as flat copies beside this cluster, which is how the corrected
    // `targetStepId` above ended up with an uncorrected twin.
    selectedStepId: device.selectedStepId,
    planningPowerKw: device.planningPowerKw,
    commandPending: !plannerOnlyTarget && hasPendingStepCommand(device),
  };
}
