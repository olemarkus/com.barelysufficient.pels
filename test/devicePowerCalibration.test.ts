import { describe, expect, it } from 'vitest';
import {
  createEmptyPowerCalibrationSnapshot,
  getAdmissionPowerKw,
  getDeliveryPowerKw,
  hasRecentDrawAt,
  normalizePowerCalibrationSnapshot,
  POWER_CALIBRATION_CONSTANTS,
  POWER_CALIBRATION_VERSION,
  pruneStale,
  recordSample,
  type RecordSampleInput,
} from '../lib/observer/devicePowerCalibration';

const baseSample = (overrides: Partial<RecordSampleInput> = {}): RecordSampleInput => ({
  deviceId: 'dev1',
  stepId: 'high',
  measuredPowerKw: 2.75,
  nameplateKw: 3,
  // Default to undefined so the freshness gate is opt-in per test.
  dataObservedAtMs: undefined,
  nowMs: 0,
  ...overrides,
});

describe('recordSample acceptance gates', () => {
  it('rejects invalid input', () => {
    const snapshot = createEmptyPowerCalibrationSnapshot();
    const outcome = recordSample(snapshot, baseSample({ deviceId: '' }));
    expect(outcome.accepted).toBe(false);
    if (!outcome.accepted) expect(outcome.reason).toBe('invalid_input');
  });

  it('rejects when nameplate is zero or negative', () => {
    const snapshot = createEmptyPowerCalibrationSnapshot();
    const outcome = recordSample(snapshot, baseSample({ nameplateKw: 0 }));
    expect(outcome.accepted).toBe(false);
    if (!outcome.accepted) expect(outcome.reason).toBe('no_nameplate');
  });

  it('rejects when measured is below the active floor', () => {
    const snapshot = createEmptyPowerCalibrationSnapshot();
    // 3 kW nameplate ⇒ floor = max(0.05, 0.3) = 0.3 kW
    const outcome = recordSample(snapshot, baseSample({ measuredPowerKw: 0.2 }));
    expect(outcome.accepted).toBe(false);
    if (!outcome.accepted) expect(outcome.reason).toBe('below_floor');
  });

  it('rejects when measured is at or below the step underneath', () => {
    const snapshot = createEmptyPowerCalibrationSnapshot();
    const equalToLower = recordSample(snapshot, baseSample({
      measuredPowerKw: 1.25,
      nameplateKw: 1.75,
      lowerStepCeilingKw: 1.25,
    }));
    expect(equalToLower.accepted).toBe(false);
    if (!equalToLower.accepted) expect(equalToLower.reason).toBe('below_lower_step');

    const belowLower = recordSample(snapshot, baseSample({
      measuredPowerKw: 1.1,
      nameplateKw: 1.75,
      lowerStepCeilingKw: 1.25,
    }));
    expect(belowLower.accepted).toBe(false);
    if (!belowLower.accepted) expect(belowLower.reason).toBe('below_lower_step');
  });

  it('rejects when measured is above the configured step ceiling', () => {
    const snapshot = createEmptyPowerCalibrationSnapshot();
    const outcome = recordSample(snapshot, baseSample({
      measuredPowerKw: 1.81,
      nameplateKw: 1.25,
    }));
    expect(outcome.accepted).toBe(false);
    if (!outcome.accepted) expect(outcome.reason).toBe('above_step_ceiling');
  });

  it('rejects stale observations', () => {
    const snapshot = createEmptyPowerCalibrationSnapshot();
    const outcome = recordSample(snapshot, baseSample({
      nowMs: 120_000,
      dataObservedAtMs: 0,
    }));
    expect(outcome.accepted).toBe(false);
    if (!outcome.accepted) expect(outcome.reason).toBe('stale_observation');
  });

  it('rejects anomalies once confident', () => {
    let snapshot = createEmptyPowerCalibrationSnapshot();
    // Build confidence with 6 samples spaced 70s apart. Each gap caps at the
    // sustained-seconds gap cap (60s), so 5 gaps × 60 = 300 seconds, hitting
    // the confidence threshold exactly.
    for (let i = 0; i < 6; i += 1) {
      const outcome = recordSample(snapshot, baseSample({
        nowMs: i * 70_000,
        measuredPowerKw: 0.5,
      }));
      expect(outcome.accepted).toBe(true);
      if (outcome.accepted) snapshot = outcome.snapshot;
    }
    const anomaly = recordSample(snapshot, baseSample({
      nowMs: 6 * 70_000 + 70_000,
      measuredPowerKw: 2.5,
    }));
    expect(anomaly.accepted).toBe(false);
    if (!anomaly.accepted) expect(anomaly.reason).toBe('anomaly');
  });
});

describe('EMA updates and confidence gates', () => {
  it('initialises observedKw to the first sample value', () => {
    const snapshot = createEmptyPowerCalibrationSnapshot();
    const outcome = recordSample(snapshot, baseSample({ measuredPowerKw: 2.75 }));
    expect(outcome.accepted).toBe(true);
    if (!outcome.accepted) return;
    const step = outcome.snapshot.devices.dev1.steps.high;
    expect(step.observedKw).toBeCloseTo(2.75);
    expect(step.samples).toBe(1);
  });

  it('returns nameplate before confidence is reached', () => {
    let snapshot = createEmptyPowerCalibrationSnapshot();
    const outcome = recordSample(snapshot, baseSample({ measuredPowerKw: 2.5 }));
    if (outcome.accepted) snapshot = outcome.snapshot;
    expect(getDeliveryPowerKw(snapshot, 'dev1', 'high', 3)).toBe(3);
    expect(getAdmissionPowerKw(snapshot, 'dev1', 'high', 3)).toBe(3);
  });

  it('once confident, admission and delivery can learn below the configured step ceiling', () => {
    let snapshot = createEmptyPowerCalibrationSnapshot();
    for (let i = 0; i < 6; i += 1) {
      const outcome = recordSample(snapshot, baseSample({
        nowMs: i * 70_000,
        measuredPowerKw: 2.5,
      }));
      if (outcome.accepted) snapshot = outcome.snapshot;
    }
    expect(getDeliveryPowerKw(snapshot, 'dev1', 'high', 3)).toBeCloseTo(2.5, 1);
    expect(getAdmissionPowerKw(snapshot, 'dev1', 'high', 3)).toBeCloseTo(2.5, 1);
  });

  it('does not learn above the configured step ceiling', () => {
    let snapshot = createEmptyPowerCalibrationSnapshot();
    for (let i = 0; i < 6; i += 1) {
      const outcome = recordSample(snapshot, baseSample({
        nowMs: i * 70_000,
        measuredPowerKw: 2.9,
        nameplateKw: 3,
      }));
      if (outcome.accepted) snapshot = outcome.snapshot;
    }
    expect(getDeliveryPowerKw(snapshot, 'dev1', 'high', 3)).toBeCloseTo(2.9, 1);
    expect(getAdmissionPowerKw(snapshot, 'dev1', 'high', 3)).toBeCloseTo(2.9, 1);

    const overCeiling = recordSample(snapshot, baseSample({
      nowMs: 7 * 70_000,
      measuredPowerKw: 3.4,
      nameplateKw: 3,
    }));
    expect(overCeiling.accepted).toBe(false);
    if (!overCeiling.accepted) expect(overCeiling.reason).toBe('above_step_ceiling');
    expect(getAdmissionPowerKw(snapshot, 'dev1', 'high', 3)).toBeCloseTo(2.9, 1);
  });
});

describe('nameplate-change reset', () => {
  it('clears existing observations when nameplate drifts beyond tolerance', () => {
    let snapshot = createEmptyPowerCalibrationSnapshot();
    for (let i = 0; i < 6; i += 1) {
      const outcome = recordSample(snapshot, baseSample({
        nowMs: i * 70_000,
        measuredPowerKw: 1.7,
        nameplateKw: 2,
      }));
      if (outcome.accepted) snapshot = outcome.snapshot;
    }
    expect(snapshot.devices.dev1.steps.high.samples).toBeGreaterThanOrEqual(5);

    const after = recordSample(snapshot, baseSample({
      nowMs: 10 * 70_000,
      measuredPowerKw: 2.6,
      nameplateKw: 3,
    }));
    expect(after.accepted).toBe(true);
    if (!after.accepted) return;
    expect(after.reset).toBe(true);
    expect(after.snapshot.devices.dev1.steps.high.samples).toBe(1);
    expect(after.snapshot.devices.dev1.steps.high.nameplateAtSampleKw).toBe(3);
  });

  it('keeps existing observations when nameplate moves within tolerance', () => {
    let snapshot = createEmptyPowerCalibrationSnapshot();
    for (let i = 0; i < 6; i += 1) {
      const outcome = recordSample(snapshot, baseSample({
        nowMs: i * 70_000,
        measuredPowerKw: 1.7,
        nameplateKw: 2,
      }));
      if (outcome.accepted) snapshot = outcome.snapshot;
    }
    const after = recordSample(snapshot, baseSample({
      nowMs: 10 * 70_000,
      measuredPowerKw: 1.75,
      nameplateKw: 2.005,
    }));
    expect(after.accepted).toBe(true);
    if (!after.accepted) return;
    expect(after.reset).toBe(false);
    expect(after.snapshot.devices.dev1.steps.high.samples).toBeGreaterThan(1);
  });
});

describe('hasRecentDrawAt', () => {
  it('returns false when there is no entry for the step', () => {
    const empty = createEmptyPowerCalibrationSnapshot();
    expect(hasRecentDrawAt({
      snapshot: empty, deviceId: 'dev1', stepId: 'high', windowMs: 10_000, nowMs: 0,
    })).toBe(false);
  });

  it('returns true within the window when observed value clears the floor', () => {
    const empty = createEmptyPowerCalibrationSnapshot();
    const first = recordSample(empty, baseSample({ nowMs: 0, measuredPowerKw: 2.75 }));
    if (!first.accepted) throw new Error('expected accepted sample');
    expect(hasRecentDrawAt({
      snapshot: first.snapshot, deviceId: 'dev1', stepId: 'high', windowMs: 60_000, nowMs: 30_000,
    })).toBe(true);
    expect(hasRecentDrawAt({
      snapshot: first.snapshot, deviceId: 'dev1', stepId: 'high', windowMs: 60_000, nowMs: 120_000,
    })).toBe(false);
  });

  it('returns false when observed value is below the floor', () => {
    const empty = createEmptyPowerCalibrationSnapshot();
    const first = recordSample(empty, baseSample({ nowMs: 0, measuredPowerKw: 2.75 }));
    if (!first.accepted) throw new Error('expected accepted sample');
    expect(hasRecentDrawAt({
      snapshot: first.snapshot,
      deviceId: 'dev1',
      stepId: 'high',
      windowMs: 60_000,
      nowMs: 30_000,
      minKw: 5,
    })).toBe(false);
  });
});

describe('pruneStale', () => {
  it('removes device entries older than the threshold', () => {
    const empty = createEmptyPowerCalibrationSnapshot();
    const first = recordSample(empty, baseSample({ nowMs: 0 }));
    if (!first.accepted) throw new Error('expected accepted sample');
    const pruned = pruneStale(first.snapshot, 1_000, 60_000);
    expect(pruned.devices.dev1).toBeUndefined();
  });

  it('keeps fresh device entries', () => {
    const empty = createEmptyPowerCalibrationSnapshot();
    const first = recordSample(empty, baseSample({ nowMs: 0 }));
    if (!first.accepted) throw new Error('expected accepted sample');
    const pruned = pruneStale(first.snapshot, 60_000, 30_000);
    expect(pruned.devices.dev1).toBeDefined();
  });

  it('is a no-op when nothing changes', () => {
    const empty = createEmptyPowerCalibrationSnapshot();
    expect(pruneStale(empty, 60_000, 30_000)).toBe(empty);
  });
});

describe('normalizePowerCalibrationSnapshot', () => {
  it('returns empty for unknown shapes', () => {
    expect(normalizePowerCalibrationSnapshot(null).version).toBe(POWER_CALIBRATION_VERSION);
    expect(normalizePowerCalibrationSnapshot({ version: 999, devices: {} }).devices).toEqual({});
    expect(normalizePowerCalibrationSnapshot('garbage').devices).toEqual({});
  });

  it('drops malformed device or step records but preserves valid siblings', () => {
    const result = normalizePowerCalibrationSnapshot({
      version: POWER_CALIBRATION_VERSION,
      devices: {
        good: {
          lastTouchedMs: 0,
          steps: {
            ok: {
              observedKw: 1,
              nameplateAtSampleKw: 2,
              samples: 1,
              sustainedSeconds: 0,
              lastSampleMs: 0,
            },
            bad: { observedKw: 'oops' },
          },
        },
        bad: { steps: 'oops' },
      },
    });
    expect(result.devices.good).toBeDefined();
    expect(result.devices.good.steps.ok).toBeDefined();
    expect(result.devices.good.steps.bad).toBeUndefined();
    // `bad` device's `steps` field is not an object → entry rejected.
    expect(result.devices.bad).toBeUndefined();
  });

  it('preserves a device entry with all-invalid steps so recovery can refill it', () => {
    // A partial corruption (every step record malformed but the device-level
    // fields intact) must not wipe the entire device — otherwise a single
    // bad step would drop all of the device's calibration history. The
    // entry survives with an empty `steps` map; subsequent samples rebuild
    // the EMA in place.
    const result = normalizePowerCalibrationSnapshot({
      version: POWER_CALIBRATION_VERSION,
      devices: {
        partial: {
          lastTouchedMs: 12345,
          steps: {
            badA: { observedKw: 'oops' },
            badB: { samples: -1, observedKw: 1, nameplateAtSampleKw: 2, sustainedSeconds: 0, lastSampleMs: 0 },
          },
        },
      },
    });
    expect(result.devices.partial).toBeDefined();
    expect(result.devices.partial.steps).toEqual({});
    expect(result.devices.partial.lastTouchedMs).toBe(12345);
  });
});

describe('exposed constants', () => {
  it('matches the documented gates', () => {
    expect(POWER_CALIBRATION_CONSTANTS.CONFIDENCE_MIN_SAMPLES).toBe(5);
    expect(POWER_CALIBRATION_CONSTANTS.CONFIDENCE_MIN_SUSTAINED_SECONDS).toBe(300);
    expect(POWER_CALIBRATION_CONSTANTS.DEFAULT_FRESHNESS_WINDOW_MS).toBe(60_000);
    expect(POWER_CALIBRATION_CONSTANTS.NAMEPLATE_TOLERANCE_RATIO).toBe(0.02);
  });
});
