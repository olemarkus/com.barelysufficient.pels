import type { DeviceObjectiveProfile } from './types';

// Windows dropped without a refused sample, so neither counts in `rejectedSamples`.
// A powerless sub-interval resets the window in `accrueSubInterval`; a value
// change after an unpowered stretch is accepted as progress with no kWh/unit,
// and the energy summed before it is dropped.
export const POWERLESS_SUB_INTERVAL_DISCARD = 'objective_profile_powerless_sub_interval';
export const UNPOWERED_PROGRESS_DISCARD = 'objective_profile_unpowered_progress';

type RejectionsUpdate = Pick<DeviceObjectiveProfile, 'rejections'>;

// Diagnostics tally of what learning refused or dropped (`rejections`); nothing
// learns from it.
const tally = (
  profile: DeviceObjectiveProfile, reason: string, discardedEnergyKWh: number,
): RejectionsUpdate => {
  const previous = profile.rejections?.[reason];
  return {
    rejections: {
      ...profile.rejections,
      [reason]: {
        count: (previous?.count ?? 0) + 1,
        // A backward clock step can bill an open sub-interval negative; it lost nothing,
        // and a negative tally would fail the persisted profile's validation.
        discardedEnergyKWh: (previous?.discardedEnergyKWh ?? 0) + Math.max(0, discardedEnergyKWh),
      },
    },
  };
};

/** A refused sample: the lifetime counter and its reason, with the energy a voided window had summed. */
export const countRefusal = (
  profile: DeviceObjectiveProfile, reason: string, discardedEnergyKWh = 0,
): RejectionsUpdate & Pick<DeviceObjectiveProfile, 'rejectedSamples'> => ({
  rejectedSamples: profile.rejectedSamples + 1,
  ...tally(profile, reason, discardedEnergyKWh),
});

/** Counts only when energy was lost: a reset from an idle baseline is just the next window's start. */
export const tallyPowerlessReset = (profile: DeviceObjectiveProfile): RejectionsUpdate | Record<string, never> => {
  const discardedEnergyKWh = profile.pendingEnergyKWh ?? 0;
  return discardedEnergyKWh > 0 ? tally(profile, POWERLESS_SUB_INTERVAL_DISCARD, discardedEnergyKWh) : {};
};

export const tallyUnpoweredProgress = (profile: DeviceObjectiveProfile): RejectionsUpdate => (
  tally(profile, UNPOWERED_PROGRESS_DISCARD, profile.pendingEnergyKWh ?? 0)
);
