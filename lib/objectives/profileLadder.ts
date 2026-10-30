import type { PowerTrackerState } from '../power/trackerTypes';
import type { DeviceObjectiveProfile, ObjectiveDeviceInput } from './types';
import { OBJECTIVE_PROFILE_SAMPLE_BUFFER_SIZE, fitBandsFromSamples, resolveKwhPerUnitStat } from './bands';

/**
 * Whose learned rate a smart task is sized from: the device, and the car whose
 * battery its level is when the producer knows it (`level.carId`). `carId` is
 * `null` for every non-EV device and for a level that arrived on the charger
 * device, which cannot say which car it describes.
 */
export type ObjectiveProfileSubject = {
  deviceId: string;
  carId: string | null;
};

export const resolveObjectiveProfileSubject = (
  device: Pick<ObjectiveDeviceInput, 'id' | 'stateOfCharge'>,
): ObjectiveProfileSubject => {
  const level = device.stateOfCharge?.level;
  return { deviceId: device.id, carId: level?.kind === 'known' ? level.carId : null };
};

/**
 * Most specific first:
 * - `car_on_charger`: this car's rate learned on this charger.
 * - `car_any_charger`: this car's rate pooled across every charger it was
 *   learned on, for a car on a charger it has no rate for yet.
 * - `charger`: the device's own rate, from levels that arrived on the device
 *   (and, for a charger, everything learned before per-car learning existed).
 * The EV bootstrap rate below them all is the energy resolver's.
 */
export type ObjectiveProfileRung = 'car_on_charger' | 'car_any_charger' | 'charger';

/** What the energy resolver reads from a profile, whichever rung supplied it. */
export type ObjectiveRateProfile = Pick<
  DeviceObjectiveProfile,
  'updatedAtMs' | 'acceptedSamples' | 'kwhPerUnit' | 'bands' | 'samples'
>;

export type ObjectiveRateProfileCandidate = {
  rung: ObjectiveProfileRung;
  profile: ObjectiveRateProfile;
};

/**
 * The profiles that could size this subject's task, most specific first. The
 * caller takes the first one with a usable rate for its direction; a rung that
 * exists but has learned nothing yet falls through to the next.
 */
export const listObjectiveRateProfileCandidates = (
  state: PowerTrackerState,
  subject: ObjectiveProfileSubject,
): ObjectiveRateProfileCandidate[] => {
  const carProfiles = subject.carId === null ? undefined : state.carObjectiveProfiles?.[subject.carId];
  const onThisCharger = carProfiles?.[subject.deviceId];
  const pooled = carProfiles === undefined ? undefined : poolCarProfiles(Object.values(carProfiles));
  const own = state.objectiveProfiles?.[subject.deviceId];
  return [
    ...(onThisCharger ? [{ rung: 'car_on_charger' as const, profile: onThisCharger }] : []),
    ...(pooled ? [{ rung: 'car_any_charger' as const, profile: pooled }] : []),
    ...(own ? [{ rung: 'charger' as const, profile: own }] : []),
  ];
};

/**
 * One car's observations across its chargers, as one profile. Derived at read
 * time rather than learned separately: the observations are already in the
 * per-charger buffers, and a second learner would need its own window state
 * across a car that moves between chargers. The newest observations win the
 * buffer's size cap, as they do in a single profile.
 */
const poolCarProfiles = (profiles: readonly DeviceObjectiveProfile[]): ObjectiveRateProfile | undefined => {
  if (profiles.length === 0) return undefined;
  const updatedAtMs = Math.max(...profiles.map((profile) => profile.updatedAtMs));
  const samples = [...profiles.flatMap((profile) => profile.samples ?? [])]
    .sort((left, right) => left.observedAtMs - right.observedAtMs)
    .slice(-OBJECTIVE_PROFILE_SAMPLE_BUFFER_SIZE);
  const lastAcceptedAtMs = Math.max(...profiles.map((profile) => profile.kwhPerUnit?.lastUpdatedMs ?? 0));
  const kwhPerUnit = resolveKwhPerUnitStat(samples, lastAcceptedAtMs > 0 ? lastAcceptedAtMs : updatedAtMs);
  const bands = fitBandsFromSamples({ samples });
  return {
    updatedAtMs,
    acceptedSamples: profiles.reduce((sum, profile) => sum + profile.acceptedSamples, 0),
    samples,
    ...(kwhPerUnit === undefined ? {} : { kwhPerUnit }),
    ...(bands === undefined ? {} : { bands }),
  };
};
