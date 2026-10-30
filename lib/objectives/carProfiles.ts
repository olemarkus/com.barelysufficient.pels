import type { DeviceObjectiveProfile } from './types';

/**
 * Learned kWh per percent of each car linked to a charger, keyed by the car's id
 * and then the charger's device id: the first rung of the lookup ladder in
 * `profileLadder.ts`. Only a level PELS read off an associated car feeds it, so
 * a second car on the same charger, or a guest car, learns its own battery
 * instead of blending into the charger's rate.
 *
 * Bounded so a home that has seen many cars cannot grow the persisted tracker
 * without limit. Each profile holds at most `OBJECTIVE_PROFILE_SAMPLE_BUFFER_SIZE`
 * observations, so the worst case is `MAX_CARS × MAX_CHARGERS_PER_CAR` profiles,
 * the same order as a handful of extra devices. The cars that can land here are
 * the ones the user ticked for a charger, so the caps are generous for a real
 * household; what they bound is the tail of cars that have left.
 */
export type CarObjectiveProfiles = Record<string, Record<string, DeviceObjectiveProfile>>;

export const CAR_OBJECTIVE_PROFILE_MAX_CARS = 8;
export const CAR_OBJECTIVE_PROFILE_MAX_CHARGERS_PER_CAR = 4;
/**
 * Longer than the device profiles' 30 days: a car's battery does not change
 * while it is away, and a car that charges here once a season should not have
 * to relearn from the bootstrap rate each time. The caps above still bound the
 * total.
 */
export const CAR_OBJECTIVE_PROFILE_RETENTION_MS = 180 * 24 * 60 * 60 * 1000;

/** A (car, charger) pair that reported a level this cycle. */
export type ActiveCarProfileKey = { carId: string; deviceId: string };

type RankedEntry = [string, DeviceObjectiveProfile];

// Active entries first, then the most recently updated. A profile that was
// sampled this cycle but did not change keeps its older `updatedAtMs`, so
// activity has to be ranked on its own rather than read off the stamp.
const rankEntries = (entries: RankedEntry[], isActive: (key: string) => boolean): RankedEntry[] => (
  [...entries].sort((left, right) => (
    Number(isActive(right[0])) - Number(isActive(left[0]))
    || right[1].updatedAtMs - left[1].updatedAtMs
  ))
);

const newestUpdate = (chargers: Record<string, DeviceObjectiveProfile>): number => (
  Math.max(...Object.values(chargers).map((profile) => profile.updatedAtMs))
);

/**
 * Drops (car, charger) profiles past retention unless active this cycle, then
 * keeps each car's `MAX_CHARGERS_PER_CAR` most relevant chargers and the
 * `MAX_CARS` most relevant cars. Returns `profiles` itself when nothing goes, so
 * the caller can tell a no-op from a change by reference.
 */
export function pruneCarObjectiveProfiles(
  profiles: CarObjectiveProfiles,
  active: readonly ActiveCarProfileKey[],
  nowMs: number,
): CarObjectiveProfiles {
  const activeChargersByCar = new Map<string, Set<string>>();
  for (const { carId, deviceId } of active) {
    const chargers = activeChargersByCar.get(carId) ?? new Set<string>();
    chargers.add(deviceId);
    activeChargersByCar.set(carId, chargers);
  }
  const carEntries = Object.entries(profiles);
  const keptCars = carEntries.flatMap(([carId, chargers]): Array<[string, Record<string, DeviceObjectiveProfile>]> => {
    const activeChargers = activeChargersByCar.get(carId);
    const isActive = (deviceId: string): boolean => activeChargers?.has(deviceId) === true;
    const entries = Object.entries(chargers);
    const retained = entries.filter(([deviceId, profile]) => (
      isActive(deviceId) || nowMs - profile.updatedAtMs <= CAR_OBJECTIVE_PROFILE_RETENTION_MS
    ));
    const kept = rankEntries(retained, isActive).slice(0, CAR_OBJECTIVE_PROFILE_MAX_CHARGERS_PER_CAR);
    if (kept.length === 0) return [];
    return [[carId, kept.length === entries.length ? chargers : Object.fromEntries(kept)]];
  });
  const removedCharger = keptCars.length !== carEntries.length
    || keptCars.some(([carId, chargers]) => chargers !== profiles[carId]);
  if (!removedCharger && keptCars.length <= CAR_OBJECTIVE_PROFILE_MAX_CARS) return profiles;
  const rankedCars = [...keptCars].sort((left, right) => (
    Number(activeChargersByCar.has(right[0])) - Number(activeChargersByCar.has(left[0]))
    || newestUpdate(right[1]) - newestUpdate(left[1])
  ));
  return Object.fromEntries(rankedCars.slice(0, CAR_OBJECTIVE_PROFILE_MAX_CARS));
}

/** `profiles` with each update written at its (car, charger) key. */
export function withCarProfileUpdates(
  profiles: CarObjectiveProfiles,
  updates: ReadonlyArray<ActiveCarProfileKey & { profile: DeviceObjectiveProfile }>,
): CarObjectiveProfiles {
  const touchedCars = new Set(updates.map((update) => update.carId));
  return {
    ...profiles,
    ...Object.fromEntries([...touchedCars].map((carId) => [carId, {
      ...profiles[carId],
      ...Object.fromEntries(updates
        .filter((update) => update.carId === carId)
        .map((update) => [update.deviceId, update.profile])),
    }])),
  };
}
