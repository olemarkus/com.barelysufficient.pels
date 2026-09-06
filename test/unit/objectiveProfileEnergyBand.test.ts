import type { ObjectiveObservedQuantity } from '../../packages/shared-domain/src/objectiveObservedQuantity';
import { withResolvedCurrentDraw } from '../utils/objectiveSampleDevice';
import { stateOfChargeFixture } from '../utils/stateOfChargeFixture';
import {
  updateDeviceObjectiveProfile,
  updateObjectiveProfilesFromSnapshot,
} from '../../lib/objectives/profiles';
import {
  OBJECTIVE_PROFILE_BOOTSTRAP_MAX_KWH_PER_UNIT,
  OBJECTIVE_PROFILE_MIN_BAND_HISTORY,
  resolveEnergyPerUnitBand,
} from '../../lib/objectives/energyBand';
import { OBJECTIVE_PROFILE_SAMPLE_HORIZON_MS } from '../../lib/objectives/bands';
import type {
  DeviceObjectiveProfile,
  DeviceObjectiveProfileSample,
} from '../../lib/objectives/types';
import type { PowerTrackerState } from '../../lib/power/tracker';
import type { MeasuredPowerObservedProbe, StateOfChargeObservedProbe, TargetDeviceSnapshot, TemperatureObservedProbe } from '../../packages/contracts/src/types';

const startMs = Date.UTC(2026, 0, 1, 0, 0, 0);
const hourMs = 60 * 60 * 1000;
const WINDOW_POWER_W = 2000;

type TemperatureDeviceOverrides = Partial<TargetDeviceSnapshot & TemperatureObservedProbe
  & StateOfChargeObservedProbe & MeasuredPowerObservedProbe> & { currentTemperature?: number };

const temperatureDevice = (overrides: TemperatureDeviceOverrides = {}): TargetDeviceSnapshot & TemperatureObservedProbe & StateOfChargeObservedProbe & MeasuredPowerObservedProbe & { currentDrawKw: number; observedQuantity: ObjectiveObservedQuantity } => {
  const { currentTemperature = 50, ...rest } = overrides;
  const target = { id: 'target_temperature' as const, value: 75, unit: '°C' };
  return withResolvedCurrentDraw({
    available: true,
    id: 'heater-1',
    expectedPowerKw: 1,
    expectedPowerSource: 'default',
    name: 'Water heater',
    targets: [target],
    deviceType: 'temperature',
    binaryControl: { on: true },
    temperature: { currentTemperature, target },
    lastFreshDataMs: startMs,
    measuredPowerKw: WINDOW_POWER_W / 1000,
    ...rest,
  });
};

const evDevice = (overrides: Partial<TargetDeviceSnapshot & TemperatureObservedProbe & StateOfChargeObservedProbe & MeasuredPowerObservedProbe> = {}): TargetDeviceSnapshot & TemperatureObservedProbe & StateOfChargeObservedProbe & MeasuredPowerObservedProbe & { currentDrawKw: number; observedQuantity: ObjectiveObservedQuantity } => withResolvedCurrentDraw({
  available: true,
  id: 'ev-1',
  expectedPowerKw: 1,
  expectedPowerSource: 'default',
  name: 'Charger',
  targets: [],
  deviceClass: 'evcharger',
  binaryControl: { on: true },
  measuredPowerKw: 7,
  stateOfCharge: stateOfChargeFixture({ percent: 40, observedAtMs: startMs }),
  ...overrides,
});

const sampleAt = (
  observedAtMs: number,
  value: number,
): DeviceObjectiveProfileSample => ({
  observedAtMs,
  value,
  crediblePowerW: WINDOW_POWER_W,
  powerSource: 'measured',
});

/**
 * A profile that has already learned: `history` accepted kWh/unit observations
 * in the buffer, its baseline drawing power, ready for one more window.
 *
 * The buffer is what the band is computed from, so seeding it is seeding the
 * device's own idea of what it costs to move one unit.
 */
const profileWithHistory = (
  history: number[],
  baselineValue = 50,
): DeviceObjectiveProfile => ({
  updatedAtMs: startMs,
  lastSample: sampleAt(startMs, baselineValue),
  acceptedSamples: history.length,
  rejectedSamples: 0,
  kwhPerUnit: {
    sampleCount: history.length,
    mean: history.reduce((sum, value) => sum + value, 0) / history.length,
    m2: 0,
    min: Math.min(...history),
    max: Math.max(...history),
    confidence: 'high',
    lastUpdatedMs: startMs,
  },
  samples: history.map((kwhPerUnit, index) => ({
    observedAtMs: startMs - (history.length - index) * hourMs,
    inputValue: baselineValue,
    kwhPerUnit,
  })),
});

// Ten windows that each cost half a kWh per degree — a tank that has been
// heating unremarkably for ten hours.
const ORDINARY_HISTORY = Array.from({ length: 10 }, () => 0.5);

/**
 * One window, priced. `valueDelta` degrees appear over an hour while the device
 * draws `WINDOW_POWER_W`, so the window bills 2 kWh and the rate the profile
 * sees is `2 / valueDelta`.
 */
const applyWindow = (
  previous: DeviceObjectiveProfile,
  valueDelta: number,
  debugStructured?: (payload: Record<string, unknown>) => void,
): DeviceObjectiveProfile => updateDeviceObjectiveProfile({
  previous,
  sample: sampleAt(
    previous.lastSample.observedAtMs + hourMs,
    previous.lastSample.value + valueDelta,
  ),
  deviceId: 'heater-1',
  ...(debugStructured ? { debugStructured } : {}),
});

const bandAt = (
  nowMs: number,
  profile: DeviceObjectiveProfile,
): ReturnType<typeof resolveEnergyPerUnitBand> => resolveEnergyPerUnitBand(profile, nowMs);

describe('objective profile energy band', () => {
  it('learns an ordinary window against the device\'s own history', () => {
    const previous = profileWithHistory(ORDINARY_HISTORY);
    // 2 kWh over 4 °C = 0.5 kWh/°C — exactly what this tank has always cost.
    const next = applyWindow(previous, 4);

    expect(next.acceptedSamples).toBe(11);
    expect(next.rejectedSamples).toBe(0);
    expect(next.kwhPerUnit?.sampleCount).toBe(11);
  });

  it('refuses a refill window that costs several times what the device has ever needed', () => {
    const previous = profileWithHistory(ORDINARY_HISTORY);
    const debugStructured = vi.fn();
    // A draw left the tank stratified: 2 kWh buys 0.8 °C at the sensor while the
    // cold water underneath is reheated — five times the device's norm. That is
    // the refill, and it is not heating.
    const next = applyWindow(previous, 0.8, debugStructured);

    expect(next.acceptedSamples).toBe(10);
    expect(next.rejectedSamples).toBe(1);
    // The learned rate is untouched — the whole point.
    expect(next.kwhPerUnit?.sampleCount).toBe(10);
    expect(next.samples).toHaveLength(10);
    expect(debugStructured).toHaveBeenCalledWith(expect.objectContaining({
      event: 'objective_profile_sample_rejected',
      reasonCode: 'objective_profile_energy_per_unit_out_of_range',
      kwhPerUnit: expect.closeTo(2.5, 6),
      bandBasis: 'learned',
    }));
  });

  it('refuses a window that credits units nobody paid for', () => {
    // The mirror image of a refill: a charge report steps and 40 units appear
    // for 2 kWh — 0.05 per unit against a device that has always needed 0.5.
    const previous = profileWithHistory(ORDINARY_HISTORY);
    const next = applyWindow(previous, 40);

    expect(next.acceptedSamples).toBe(10);
    expect(next.rejectedSamples).toBe(1);
    expect(next.kwhPerUnit?.sampleCount).toBe(10);
  });

  it('judges each window on its own merit, so the one after a refill still teaches', () => {
    // The retired recovery window suspended ALL learning until the value climbed
    // back to the pre-drop level. Refusing the bad window alone is what lets the
    // ordinary window immediately behind it count.
    const previous = profileWithHistory(ORDINARY_HISTORY);
    const afterRefill = applyWindow(previous, 0.8);
    const afterOrdinary = applyWindow(afterRefill, 4);

    expect(afterOrdinary.acceptedSamples).toBe(11);
    expect(afterOrdinary.rejectedSamples).toBe(1);
  });

  it('keeps learning from a device that cools away and never returns to its pre-drop value', () => {
    // A capacity-shed thermostat cools *away* from where it was. The recovery
    // window it used to arm needed a no-progress counter and a 24h safety
    // timeout to let go of such a device; there is no window to let go of now.
    const previous = profileWithHistory(ORDINARY_HISTORY);
    const afterFall = updateDeviceObjectiveProfile({
      previous,
      sample: sampleAt(startMs + hourMs, previous.lastSample.value - 8),
      deviceId: 'heater-1',
    });
    expect(afterFall.rejectedSamples).toBe(1);
    // The fall reseeded the baseline; the next ordinary rise is measured from
    // the new low and learned at once, still far below the pre-drop value.
    const afterRise = applyWindow(afterFall, 4);

    expect(afterRise.acceptedSamples).toBe(11);
    expect(afterRise.lastSample.value).toBe(46);
  });

  it('voids the window it refused, so the refused energy is not billed to the next one', () => {
    // The sums are cumulative from the baseline. A refusal that merely declined
    // to learn would leave the refill's 2 kWh and 0.8 units in the open window,
    // and the next ordinary rise would arrive as 4 kWh across 4.8 units — 0.83
    // for a device whose rate is 0.5, inside the band and accepted. The
    // contamination the band just refused would get in behind it.
    const previous = profileWithHistory(ORDINARY_HISTORY);
    const afterRefill = applyWindow(previous, 0.8);

    expect(afterRefill.rejectedSamples).toBe(1);
    // The baseline moved onto the refused sample and the partial sum is gone.
    expect(afterRefill.lastSample.observedAtMs).toBe(startMs + hourMs);
    expect(afterRefill.lastSample.value).toBeCloseTo(50.8, 6);
    expect(afterRefill.pendingEnergyKWh).toBeUndefined();
    expect(afterRefill.subIntervalStartMs).toBeUndefined();

    // So the next window is priced on its own: 2 kWh over 4 °C, not 4 over 4.8.
    const debugStructured = vi.fn();
    const afterOrdinary = applyWindow(afterRefill, 4, debugStructured);
    expect(afterOrdinary.acceptedSamples).toBe(11);
    expect(debugStructured).toHaveBeenCalledWith(expect.objectContaining({
      event: 'objective_profile_sample_recorded',
      kwhPerUnit: expect.closeTo(0.5, 6),
    }));
  });

  it('keeps the window open when the refusal is about the sample, not the window', () => {
    // A sample too soon to bill leaves the window open on purpose: voiding there
    // would restart it on every poll and no window would ever reach the minimum
    // interval.
    const previous = profileWithHistory(ORDINARY_HISTORY);
    const next = updateDeviceObjectiveProfile({
      previous,
      sample: sampleAt(startMs + 60 * 1000, previous.lastSample.value + 4),
      // Its own id: the rejection log throttles per (device, reason), and the
      // spec below asserts that same reason is emitted for `heater-1`.
      deviceId: 'heater-2',
    });

    expect(next.rejectedSamples).toBe(1);
    expect(next.lastSample).toEqual(previous.lastSample);
  });

  it('applies the coarse bootstrap bound while the device has no history of its own', () => {
    const young = profileWithHistory(Array.from(
      { length: OBJECTIVE_PROFILE_MIN_BAND_HISTORY - 1 },
      () => 0.5,
    ));
    // Seven observations is not a distribution, so there is nothing yet to judge
    // a window against: 2 kWh over 5 °C is admitted on the coarse bound alone.
    expect(applyWindow(young, 5).acceptedSamples)
      .toBe(OBJECTIVE_PROFILE_MIN_BAND_HISTORY);
    // Junk still cannot get in: 2 kWh over 0.2 °C is 10 kWh/°C.
    expect(applyWindow(young, 0.2).rejectedSamples).toBe(1);
  });

  it('refuses a timing-invalid sample before it is ever priced', () => {
    const previous = profileWithHistory(ORDINARY_HISTORY);
    const debugStructured = vi.fn();
    const next = updateDeviceObjectiveProfile({
      previous,
      // One minute after the baseline — below the minimum sampling interval, so
      // there is no window to bill and no energy verdict to reach.
      sample: sampleAt(startMs + 60 * 1000, previous.lastSample.value + 4),
      deviceId: 'heater-1',
      debugStructured,
    });

    expect(next.rejectedSamples).toBe(1);
    expect(debugStructured).toHaveBeenCalledWith(expect.objectContaining({
      reasonCode: 'objective_profile_interval_too_short',
    }));
    expect(debugStructured).not.toHaveBeenCalledWith(expect.objectContaining({
      reasonCode: 'objective_profile_energy_per_unit_out_of_range',
    }));
  });
});

describe('resolveEnergyPerUnitBand', () => {
  it('falls back to the coarse bootstrap bound below the history floor', () => {
    const band = bandAt(startMs, profileWithHistory(Array.from(
      { length: OBJECTIVE_PROFILE_MIN_BAND_HISTORY - 1 },
      () => 0.5,
    )));

    expect(band).toEqual({
      basis: 'bootstrap',
      lowerKwhPerUnit: 0,
      upperKwhPerUnit: OBJECTIVE_PROFILE_BOOTSTRAP_MAX_KWH_PER_UNIT,
    });
  });

  it('keeps a ratio floor under the band so a device seen in one regime is not pinned to it', () => {
    // Every observation identical: the robust spread is zero. A band of three
    // times nothing would refuse the next window over a rounding difference, and
    // would lock out a stepped device that has only ever run on one step.
    const band = bandAt(startMs, profileWithHistory(ORDINARY_HISTORY));

    expect(band.basis).toBe('learned');
    expect(band.lowerKwhPerUnit).toBeCloseTo(0.125, 6);
    expect(band.upperKwhPerUnit).toBeCloseTo(2, 6);
  });

  it('widens with the device\'s own spread', () => {
    const spread = bandAt(startMs, profileWithHistory(
      [0.30, 0.35, 0.40, 0.45, 0.50, 0.55, 0.60, 0.65, 0.70, 0.75],
    ));

    expect(spread.upperKwhPerUnit)
      .toBeGreaterThan(bandAt(startMs, profileWithHistory(ORDINARY_HISTORY)).upperKwhPerUnit);
  });

  it('ages its history out, so a device whose true rate moved is not locked out for good', () => {
    // A refusal never enters the buffer, so a device whose honest rate moves
    // further than the band admits — a different car on the same charger — would
    // refuse every window forever and never learn the new one. The horizon is the
    // escape: once the old observations fall outside it the profile drops back to
    // the bootstrap bound and relearns.
    const profile = profileWithHistory(ORDINARY_HISTORY);
    const muchLater = startMs + OBJECTIVE_PROFILE_SAMPLE_HORIZON_MS + hourMs;

    expect(resolveEnergyPerUnitBand(profile, startMs).basis).toBe('learned');
    expect(resolveEnergyPerUnitBand(profile, muchLater)).toEqual({
      basis: 'bootstrap',
      lowerKwhPerUnit: 0,
      upperKwhPerUnit: OBJECTIVE_PROFILE_BOOTSTRAP_MAX_KWH_PER_UNIT,
    });
  });

  it('does not widen when a single contaminated window slips into the history', () => {
    // The feedback loop this band exists to avoid: an admitted outlier joins the
    // history the next window is judged against. A mean-and-sigma band would
    // move twice — the centre toward the outlier, the spread further — and admit
    // more each round. A median and a median absolute deviation do not move for
    // one sample in eleven — not even for one that sat just inside the old band.
    const clean = bandAt(startMs, profileWithHistory(ORDINARY_HISTORY));
    const contaminated = bandAt(startMs, profileWithHistory([...ORDINARY_HISTORY, 1.9]));

    expect(contaminated.upperKwhPerUnit).toBeCloseTo(clean.upperKwhPerUnit, 6);
  });
});

describe('the learned rate follows the same horizon as admission', () => {
  it('rebuilds the global stat from the buffer, so an aged-out window leaves the mean', () => {
    // The escape from a lockout is only half done if admission reopens and the
    // rate the planner sizes from stays old. `resolveProfileEnergy` reads
    // `kwhPerUnit.mean`, so that stat has to follow the buffer, which means it
    // has to be derived from it rather than accumulated beside it — a running
    // Welford pair cannot have an aged-out window taken back out.
    const previous = profileWithHistory(ORDINARY_HISTORY);
    expect(previous.kwhPerUnit?.mean).toBeCloseTo(0.5, 6);

    // Two weeks and change later the tank is on a different rate entirely. Its
    // history has aged out, so the window is admitted...
    const lateMs = startMs + OBJECTIVE_PROFILE_SAMPLE_HORIZON_MS + hourMs;
    const next = updateDeviceObjectiveProfile({
      previous: { ...previous, lastSample: sampleAt(lateMs, 50) },
      // 2 kWh over 1.25 °C = 1.6 kWh/°C, more than three times the old rate.
      sample: sampleAt(lateMs + hourMs, 51.25),
      deviceId: 'heater-3',
    });

    expect(next.acceptedSamples).toBe(11);
    // ...and the stat the planner reads is the new rate alone, not an average
    // dragged down by ten expired observations.
    expect(next.samples).toHaveLength(1);
    expect(next.kwhPerUnit?.sampleCount).toBe(1);
    expect(next.kwhPerUnit?.mean).toBeCloseTo(1.6, 6);
  });

  it('keeps in-horizon observations, so an ordinary device is not relearning constantly', () => {
    const previous = profileWithHistory(ORDINARY_HISTORY);
    const next = applyWindow(previous, 4);

    expect(next.samples).toHaveLength(11);
    expect(next.kwhPerUnit?.sampleCount).toBe(11);
    expect(next.kwhPerUnit?.mean).toBeCloseTo(0.5, 6);
    // The lifetime counter is untouched by the horizon — provenance still
    // reports how much this device has ever taught the profile.
    expect(next.acceptedSamples).toBe(11);
  });
});

describe('objective profiles through the snapshot pipeline', () => {
  it('does not pollute kwhPerUnit when a refill cycle is in progress', () => {
    // The scenario the retired recovery window was built for, now carried by the
    // band: ten ordinary hours of heating, a hot-water draw, then a rebuild that
    // costs far more per degree than this tank has ever needed.
    let state: PowerTrackerState = {};
    for (let hour = 0; hour <= 10; hour += 1) {
      state = updateObjectiveProfilesFromSnapshot({
        state,
        devices: [temperatureDevice({
          // 4 °C an hour at 2 kW: 0.5 kWh/°C, every hour.
          currentTemperature: 30 + hour * 4,
          lastFreshDataMs: startMs + hour * hourMs,
        })],
        nowMs: startMs + hour * hourMs,
      });
    }
    const learned = state.objectiveProfiles?.['heater-1'];
    expect(learned?.acceptedSamples).toBe(10);
    expect(learned?.kwhPerUnit?.mean).toBeCloseTo(0.5, 6);

    // The draw: a sharp fall reseeds the baseline and teaches nothing.
    state = updateObjectiveProfilesFromSnapshot({
      state,
      devices: [temperatureDevice({
        currentTemperature: 40,
        lastFreshDataMs: startMs + 11 * hourMs,
      })],
      nowMs: startMs + 11 * hourMs,
    });
    // The refill: 2 kWh buys 0.8 °C at the sensor while the tank re-heats the
    // cold water underneath it.
    state = updateObjectiveProfilesFromSnapshot({
      state,
      devices: [temperatureDevice({
        currentTemperature: 40.8,
        lastFreshDataMs: startMs + 12 * hourMs,
      })],
      nowMs: startMs + 12 * hourMs,
    });

    const profile = state.objectiveProfiles?.['heater-1'];
    expect(profile?.acceptedSamples).toBe(10);
    expect(profile?.rejectedSamples).toBe(2);
    expect(profile?.kwhPerUnit?.sampleCount).toBe(10);
    expect(profile?.kwhPerUnit?.mean).toBeCloseTo(0.5, 6);
  });

  it('refuses a charge report that steps, exactly as a tank\'s refill is refused', () => {
    // A battery whose reported level jumps and a tank that refills with cold
    // water are the same event to this layer: the energy that went in does not
    // match the units that appeared. Neither is named here, and neither needs
    // to be.
    let state: PowerTrackerState = {};
    for (let hour = 0; hour <= 10; hour += 1) {
      state = updateObjectiveProfilesFromSnapshot({
        state,
        devices: [evDevice({
          // 7 kWh an hour for 10 % — 0.7 kWh per unit, every hour.
          stateOfCharge: stateOfChargeFixture({
            percent: 10 + hour * 10,
            observedAtMs: startMs + hour * hourMs,
          }),
        })],
        nowMs: startMs + hour * hourMs,
      });
    }
    const learned = state.objectiveProfiles?.['ev-1'];
    expect(learned?.acceptedSamples).toBe(10);
    expect(learned?.kwhPerUnit?.mean).toBeCloseTo(0.7, 6);

    // Recalibration: the reported level drops, which reseeds the baseline...
    state = updateObjectiveProfilesFromSnapshot({
      state,
      devices: [evDevice({
        stateOfCharge: stateOfChargeFixture({
          percent: 60,
          observedAtMs: startMs + 11 * hourMs,
        }),
      })],
      nowMs: startMs + 11 * hourMs,
    });
    // ...then steps back 50 points on 7 kWh, at 0.14 kWh per unit.
    state = updateObjectiveProfilesFromSnapshot({
      state,
      devices: [evDevice({
        stateOfCharge: stateOfChargeFixture({
          percent: 110,
          observedAtMs: startMs + 12 * hourMs,
        }),
      })],
      nowMs: startMs + 12 * hourMs,
    });

    const profile = state.objectiveProfiles?.['ev-1'];
    expect(profile?.acceptedSamples).toBe(10);
    expect(profile?.rejectedSamples).toBe(2);
    expect(profile?.kwhPerUnit?.mean).toBeCloseTo(0.7, 6);
  });
});
