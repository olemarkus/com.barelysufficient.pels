// Step 1 of Cause #1 (see notes/deferred-load-objectives/feasibility-confidence.md):
// the learned-rate energy estimate must accumulate each sub-interval at its own
// power instead of billing the whole baseline→rise window at the baseline
// sample's single power. These tests pin the accumulator behaviour across the
// `rise_too_small` skips that the baseline-preserving path used to discard.
import { updateDeviceObjectiveProfile } from '../lib/objectives/profiles';
import type { DeviceObjectiveProfile, DeviceObjectiveProfileSample } from '../lib/objectives/types';

const startMs = Date.UTC(2026, 0, 1, 0, 0, 0);
const hourMs = 60 * 60 * 1000;

const tempSample = (overrides: Partial<DeviceObjectiveProfileSample> & {
  observedAtMs: number;
  value: number;
}): DeviceObjectiveProfileSample => ({
  unit: 'degree_c',
  powerSource: 'measured',
  ...overrides,
});

const step = (
  previous: DeviceObjectiveProfile | undefined,
  sample: DeviceObjectiveProfileSample,
): DeviceObjectiveProfile => updateDeviceObjectiveProfile({ previous, sample });

describe('objective profile energy accumulator', () => {
  it('sums sub-intervals at their own left-edge power across a rise_too_small skip', () => {
    // Baseline 50.0 °C @ 1000 W; a near-flat 0.1 °C skip at +1h carries 3000 W;
    // the real 3.0 °C rise lands at +2h. Energy must be 1000 W·1h + 3000 W·1h =
    // 4.0 kWh over a 3.0 °C rise → 1.333 kWh/°C — NOT the old single-baseline
    // bill of 1000 W·2h = 2.0 kWh → 0.667 kWh/°C.
    let profile = step(undefined, tempSample({ observedAtMs: startMs, value: 50, crediblePowerW: 1000 }));
    profile = step(profile, tempSample({ observedAtMs: startMs + hourMs, value: 50.1, crediblePowerW: 3000 }));
    profile = step(profile, tempSample({ observedAtMs: startMs + 2 * hourMs, value: 53, crediblePowerW: 4000 }));

    expect(profile.acceptedSamples).toBe(1);
    expect(profile.kwhPerUnit?.mean).toBeCloseTo(4 / 3, 4);
  });

  it('keeps the baseline and banks energy on a rise_too_small skip, emitting nothing yet', () => {
    let profile = step(undefined, tempSample({ observedAtMs: startMs, value: 50, crediblePowerW: 1000 }));
    profile = step(profile, tempSample({ observedAtMs: startMs + hourMs, value: 50.1, crediblePowerW: 3000 }));

    // Baseline (lastSample) unchanged — the value barely moved.
    expect(profile.lastSample.value).toBe(50);
    expect(profile.acceptedSamples).toBe(0);
    expect(profile.kwhPerUnit).toBeUndefined();
    // Sub-interval [0, 1h] billed at the baseline's 1000 W = 1.0 kWh, with the
    // open sub-interval now starting at the skip (3000 W).
    expect(profile.pendingEnergyKWh).toBeCloseTo(1, 6);
    expect(profile.subIntervalStartMs).toBe(startMs + hourMs);
    expect(profile.subIntervalPowerW).toBe(3000);
  });

  it('clears the accumulator on the accepted rise so the next window starts fresh', () => {
    let profile = step(undefined, tempSample({ observedAtMs: startMs, value: 50, crediblePowerW: 1000 }));
    profile = step(profile, tempSample({ observedAtMs: startMs + hourMs, value: 50.1, crediblePowerW: 3000 }));
    profile = step(profile, tempSample({ observedAtMs: startMs + 2 * hourMs, value: 53, crediblePowerW: 4000 }));

    expect(profile.pendingEnergyKWh).toBeUndefined();
    expect(profile.subIntervalStartMs).toBeUndefined();
    expect(profile.subIntervalPowerW).toBeUndefined();
  });

  it('is byte-identical to single-baseline billing when no skips occur', () => {
    // Baseline 50 °C @ 2000 W, accept a 2 °C rise an hour later: 2000 W·1h = 2.0
    // kWh / 2 °C = 1.0 kWh/°C, and no accumulator fields are written.
    let profile = step(undefined, tempSample({ observedAtMs: startMs, value: 50, crediblePowerW: 2000 }));
    profile = step(profile, tempSample({ observedAtMs: startMs + hourMs, value: 52, crediblePowerW: 2000 }));

    expect(profile.kwhPerUnit?.mean).toBeCloseTo(1, 4);
    expect(profile.pendingEnergyKWh).toBeUndefined();
    expect(profile.subIntervalStartMs).toBeUndefined();
  });

  it('discards the window and resets the baseline when a sub-interval has no power', () => {
    // Baseline has no credible power → the first skip's sub-interval is thermally
    // contaminated (coasting), so the window resets to that sample instead of
    // averaging coast drift into the estimate.
    let profile = step(undefined, tempSample({ observedAtMs: startMs, value: 50, crediblePowerW: undefined }));
    profile = step(profile, tempSample({ observedAtMs: startMs + hourMs, value: 50.1, crediblePowerW: 1000 }));

    expect(profile.lastSample.value).toBe(50.1);
    expect(profile.acceptedSamples).toBe(0);
    expect(profile.pendingEnergyKWh).toBeUndefined();
    expect(profile.subIntervalStartMs).toBeUndefined();
  });

  it('discards the window on accept when a banked sub-interval coasted at zero power', () => {
    // Baseline @ 1000 W; a rise_too_small skip banks the powered prefix but the
    // skip sample itself reads 0 W (device coasted) → the open sub-interval's
    // left-edge power is now 0. The next sample is a real rise: the window is
    // thermally contaminated, so it must NOT emit a kwhPerUnit billed off only
    // the powered prefix.
    let profile = step(undefined, tempSample({ observedAtMs: startMs, value: 50, crediblePowerW: 1000 }));
    profile = step(profile, tempSample({ observedAtMs: startMs + hourMs, value: 50.1, crediblePowerW: 0 }));
    expect(profile.pendingEnergyKWh).toBeCloseTo(1, 6);
    expect(profile.subIntervalPowerW).toBe(0);
    profile = step(profile, tempSample({ observedAtMs: startMs + 2 * hourMs, value: 53, crediblePowerW: 2000 }));

    // Accepted on the value rise, but no energy sample from the contaminated window.
    expect(profile.acceptedSamples).toBe(1);
    expect(profile.kwhPerUnit).toBeUndefined();
    expect(profile.pendingEnergyKWh).toBeUndefined();
  });

  it('drops a banked partial window when the value falls (refill / draw-off)', () => {
    let profile = step(undefined, tempSample({ observedAtMs: startMs, value: 50, crediblePowerW: 1000 }));
    profile = step(profile, tempSample({ observedAtMs: startMs + hourMs, value: 50.1, crediblePowerW: 3000 }));
    expect(profile.pendingEnergyKWh).toBeCloseTo(1, 6);
    // A sharp fall (draw-off) resets the baseline; the partial window is void.
    profile = step(profile, tempSample({ observedAtMs: startMs + 2 * hourMs, value: 45, crediblePowerW: 3000 }));

    expect(profile.lastSample.value).toBe(45);
    expect(profile.pendingEnergyKWh).toBeUndefined();
    expect(profile.subIntervalStartMs).toBeUndefined();
  });
});
