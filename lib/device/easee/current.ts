import type { HomeyDeviceLike } from '../../utils/types';
import type { DeviceCapabilityMap } from '../managerControl';
import type { SteppedLoadProfile } from '../../../packages/contracts/src/types';
import { sortSteppedLoadSteps, isSteppedLoadOffStep } from '../../../packages/shared-domain/src/deviceControlProfiles';
const normalizeText = (value: unknown): string => typeof value === 'string' ? value.trim().toLowerCase() : '';
export const EASEE_CHARGER_CURRENT_CAPABILITY_ID = 'target_charger_current';

// The app's Flow action card for the same write. A user Flow using it is a
// conflict exactly as a Flow writing the capability would be, so it belongs in
// the owned native-write set the flow-conflict classifier intersects.
export const EASEE_CHARGER_CURRENT_FLOW_CARD_ID = 'setDynamicChargerCurrent';
/**
 * The smallest current an Easee charges at. Below it (0-5 A) the charger
 * pauses and draws nothing, so PELS reads any such current as the off step.
 */
export const EASEE_MIN_CHARGING_CURRENT_A = 6;
const EASEE_OWNER_URIS = new Set(['homey:app:no.easee']);
const EASEE_CHARGER_DRIVER_IDS = new Set([
  'homey:app:no.easee:charger',
  'no.easee:charger',
]);

export function isEaseeChargerCurrentCandidate(
  device: HomeyDeviceLike,
  capabilityObj: DeviceCapabilityMap,
): boolean {
  return isEaseeChargerDevice(device)
    && capabilityObj[EASEE_CHARGER_CURRENT_CAPABILITY_ID]?.setable === true;
}

export function isEaseeChargerDevice(device: HomeyDeviceLike): boolean {
  if (EASEE_OWNER_URIS.has(normalizeText(device.ownerUri ?? device.driver?.owner_uri))) return true;
  if (EASEE_OWNER_URIS.has(normalizeText(device.driverUri ?? device.driver?.uri))) return true;
  return EASEE_CHARGER_DRIVER_IDS.has(normalizeText(device.driverId ?? device.driver?.id));
}


export function resolveCurrentStep(
  profile: SteppedLoadProfile,
  capabilityObj: DeviceCapabilityMap,
): string | undefined {
    // The current is the whole answer. Easee's `onoff` mirrors "is charging"
    // (and a paused charger keeps its current), so the off-by-onoff fallback
    // below would misreport a paused 16 A charger as standing on the off step.
    // A current too low to charge at is the off step: the charger is paused.
    const currentA = capabilityObj[EASEE_CHARGER_CURRENT_CAPABILITY_ID]?.value;
    if (typeof currentA !== 'number' || !Number.isFinite(currentA)) return undefined;
    const sortedSteps = sortSteppedLoadSteps(profile.steps);
    if (currentA < EASEE_MIN_CHARGING_CURRENT_A) {
      return sortedSteps.find((step) => isSteppedLoadOffStep(profile, step.id))?.id;
    }
    // The rung whose current is nearest; a tie goes to the lower rung, which
    // the stable sort over the ascending ladder keeps first.
    // eslint-disable-next-line functional/immutable-data -- Sorts a newly allocated candidate array.
    return sortedSteps
      .flatMap((step) => (
        step.planningCurrentA === undefined || isSteppedLoadOffStep(profile, step.id)
          ? []
          : [{ id: step.id, distanceA: Math.abs(step.planningCurrentA - currentA) }]
      ))
      .sort((left, right) => left.distanceA - right.distanceA)[0]?.id;
}
