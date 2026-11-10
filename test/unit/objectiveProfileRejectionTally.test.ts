import { updateDeviceObjectiveProfile } from '../../lib/objectives/profiles';
import { isPlausiblePowerTrackerState } from '../../lib/power/trackerStateGuards';
import type { DeviceObjectiveProfile, DeviceObjectiveProfileSample } from '../../lib/objectives/types';

const startMs = Date.UTC(2026, 0, 1, 0, 0, 0);
const hourMs = 60 * 60 * 1000;

const step = (
  previous: DeviceObjectiveProfile | undefined,
  sample: DeviceObjectiveProfileSample,
): DeviceObjectiveProfile => updateDeviceObjectiveProfile(previous, sample, 'dev', 'Device', undefined);

// A floor heater stores heat before the air reading moves; when the draw stops
// first, the energy summed so far leaves learning. These pin that it is counted.
describe('objective profile rejection tally', () => {
  it('tallies a heat-up dropped by a powerless sub-interval with the energy it had summed', () => {
    let profile = step(undefined, { observedAtMs: startMs, value: 20, crediblePowerW: 1000 });
    // Held off at an unchanged reading: the hour at 1000 W is banked.
    profile = step(profile, { observedAtMs: startMs + hourMs, value: 20 });
    // Resumed, still at the same reading: the powerless stretch drops the window.
    profile = step(profile, { observedAtMs: startMs + 2 * hourMs, value: 20, crediblePowerW: 1000 });

    expect(profile.rejections?.objective_profile_powerless_sub_interval).toEqual({
      count: 1, discardedEnergyKWh: 1,
    });
    expect(profile.rejectedSamples).toBe(0);
    expect(profile.kwhPerUnit).toBeUndefined();
  });

  it('tallies a reading change after an unpowered stretch, which learns no rate', () => {
    let profile = step(undefined, { observedAtMs: startMs, value: 20, crediblePowerW: 1000 });
    profile = step(profile, { observedAtMs: startMs + hourMs, value: 20 });
    // The stored heat lifts the reading while nothing is drawn.
    profile = step(profile, { observedAtMs: startMs + 2 * hourMs, value: 20.5 });

    expect(profile.acceptedSamples).toBe(1);
    expect(profile.kwhPerUnit).toBeUndefined();
    expect(profile.rejections?.objective_profile_unpowered_progress).toEqual({
      count: 1, discardedEnergyKWh: 1,
    });
  });

  it('does not tally the start of a window from an idle baseline', () => {
    let profile = step(undefined, { observedAtMs: startMs, value: 20 });
    profile = step(profile, { observedAtMs: startMs + hourMs, value: 20, crediblePowerW: 1000 });

    expect(profile.rejections).toBeUndefined();
  });

  it('never tallies negative energy from a backward clock step', () => {
    let profile = step(undefined, { observedAtMs: startMs, value: 20, crediblePowerW: 1000 });
    // An earlier timestamp at the same reading bills the open sub-interval negative.
    profile = step(profile, { observedAtMs: startMs - hourMs, value: 20 });
    expect(profile.pendingEnergyKWh).toBeLessThan(0);
    profile = step(profile, { observedAtMs: startMs + hourMs, value: 20.5 });

    expect(profile.rejections?.objective_profile_unpowered_progress).toEqual({ count: 1, discardedEnergyKWh: 0 });
    expect(isPlausiblePowerTrackerState({ objectiveProfiles: { dev: profile } })).toBe(true);
  });

  it('tallies a refused sample by its reason', () => {
    let profile = step(undefined, { observedAtMs: startMs, value: 20, crediblePowerW: 1000 });
    profile = step(profile, { observedAtMs: startMs + hourMs, value: 19, crediblePowerW: 1000 });

    expect(profile.rejectedSamples).toBe(1);
    expect(profile.rejections?.objective_profile_value_moved_against_direction?.count).toBe(1);
  });
});
