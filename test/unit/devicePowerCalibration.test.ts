import { describe, expect, it } from 'vitest';
import {
  createEmptyPowerCalibrationSnapshot,
  getStepPowerKw,
  hasRecentDrawAt,
  isStepCalibrationConfident,
  mergeRecoveredCalibrationHistory,
  normalizePersistedPowerCalibration,
  toPersistedPowerCalibrationValue,
  POWER_CALIBRATION_VERSION,
  pruneStale,
  recordSample,
  type RecordSampleInput,
} from '../../lib/device/devicePowerCalibration';
import type { PowerCalibrationSnapshot } from '../../packages/contracts/src/powerCalibration';

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

// A confident `dev1`/`high` step as persistence hands it over, so a test can
// start from a learned power without replaying the samples that built it.
const persistedConfidentStep = (observedKw: number, nameplateAtSampleKw: number): PowerCalibrationSnapshot => ({
  version: POWER_CALIBRATION_VERSION,
  devices: {
    dev1: {
      steps: {
        high: { observedKw, nameplateAtSampleKw, samples: 10, sustainedSeconds: 600, lastSampleMs: 0 },
      },
      lastTouchedMs: 0,
    },
  },
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

  it('rejects a lowest-rung draw below 30 % of the step nameplate', () => {
    // Production's single-phase 6 A charger rung (6 A x 230 V = 1.38 kW) has no
    // rung beneath, and trickle/paused draws like these cleared the 10 % active
    // floor (0.138 kW), so version 1 learned them. The step floor is 0.414 kW.
    const snapshot = createEmptyPowerCalibrationSnapshot();
    for (const measuredPowerKw of [0.149, 0.2, 0.4]) {
      const outcome = recordSample(snapshot, baseSample({ stepId: '6a', measuredPowerKw, nameplateKw: 1.38 }));
      expect(outcome.accepted).toBe(false);
      if (!outcome.accepted) expect(outcome.reason).toBe('below_step_floor');
    }
  });

  it('learns a single-phase car on a lowest rung configured three-phase', () => {
    // 6 A x 690 W/A = 4.14 kW configured; a single-phase car draws 1.38 kW, a
    // third of nameplate, and must stay learnable.
    const outcome = recordSample(createEmptyPowerCalibrationSnapshot(), baseSample({
      stepId: '6a',
      measuredPowerKw: 1.38,
      nameplateKw: 4.14,
    }));
    expect(outcome.accepted).toBe(true);
    if (outcome.accepted) expect(outcome.snapshot.devices.dev1.steps['6a'].observedKw).toBeCloseTo(1.38);
  });

  it('keeps the rung-beneath reason where that guard is the stricter one', () => {
    // 10 A rung (2.3 kW) above an 8 A rung (1.84 kW): 0.5 kW is under both the
    // step floor (0.69 kW) and the rung beneath, and the rung beneath answers.
    const outcome = recordSample(createEmptyPowerCalibrationSnapshot(), baseSample({
      stepId: '10a',
      measuredPowerKw: 0.5,
      nameplateKw: 2.3,
      lowerStepCeilingKw: 1.84,
    }));
    expect(outcome.accepted).toBe(false);
    if (!outcome.accepted) expect(outcome.reason).toBe('below_lower_step');
  });

  it('accepts any in-band sample for a confident step: the band is the only bound', () => {
    // 1.3 kW learned against a 1.38 kW nameplate. 0.42 kW is under a third of
    // the learned power but above the 0.414 kW step floor, so it is learned;
    // 0.40 kW is under the floor and rejected there.
    const snapshot = persistedConfidentStep(1.3, 1.38);
    const inBand = recordSample(snapshot, baseSample({ nowMs: 70_000, measuredPowerKw: 0.42, nameplateKw: 1.38 }));
    expect(inBand.accepted).toBe(true);
    const belowFloor = recordSample(snapshot, baseSample({ nowMs: 70_000, measuredPowerKw: 0.4, nameplateKw: 1.38 }));
    expect(belowFloor.accepted).toBe(false);
    if (!belowFloor.accepted) expect(belowFloor.reason).toBe('below_step_floor');
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
    expect(getStepPowerKw(snapshot, 'dev1', 'high', 3)).toBe(3);
  });

  it('once confident, the learned power can sit below the configured step ceiling', () => {
    let snapshot = createEmptyPowerCalibrationSnapshot();
    for (let i = 0; i < 6; i += 1) {
      const outcome = recordSample(snapshot, baseSample({
        nowMs: i * 70_000,
        measuredPowerKw: 2.5,
      }));
      if (outcome.accepted) snapshot = outcome.snapshot;
    }
    expect(getStepPowerKw(snapshot, 'dev1', 'high', 3)).toBeCloseTo(2.5, 1);
  });

  it('falls back to current nameplate when a confident entry was learned for different step watts', () => {
    let snapshot = createEmptyPowerCalibrationSnapshot();
    for (let i = 0; i < 6; i += 1) {
      const outcome = recordSample(snapshot, baseSample({
        nowMs: i * 70_000,
        measuredPowerKw: 1.7,
        nameplateKw: 2,
      }));
      if (outcome.accepted) snapshot = outcome.snapshot;
    }

    expect(getStepPowerKw(snapshot, 'dev1', 'high', 2)).toBeCloseTo(1.7, 1);
    expect(getStepPowerKw(snapshot, 'dev1', 'high', 3)).toBe(3);
    expect(isStepCalibrationConfident(snapshot, 'dev1', 'high', 3)).toBe(false);
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
    expect(getStepPowerKw(snapshot, 'dev1', 'high', 3)).toBeCloseTo(2.9, 1);

    const overCeiling = recordSample(snapshot, baseSample({
      nowMs: 7 * 70_000,
      measuredPowerKw: 3.4,
      nameplateKw: 3,
    }));
    expect(overCeiling.accepted).toBe(false);
    if (!overCeiling.accepted) expect(overCeiling.reason).toBe('above_step_ceiling');
    expect(getStepPowerKw(snapshot, 'dev1', 'high', 3)).toBeCloseTo(2.9, 1);
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

  it('returns false when the current step watts no longer match the learned nameplate', () => {
    const empty = createEmptyPowerCalibrationSnapshot();
    const first = recordSample(empty, baseSample({ nowMs: 0, measuredPowerKw: 2.75, nameplateKw: 3 }));
    if (!first.accepted) throw new Error('expected accepted sample');
    expect(hasRecentDrawAt({
      snapshot: first.snapshot,
      deviceId: 'dev1',
      stepId: 'high',
      windowMs: 60_000,
      nowMs: 30_000,
      nameplateKw: 4,
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

describe('normalizePersistedPowerCalibration', () => {
  it('returns empty for unknown shapes', () => {
    expect(normalizePersistedPowerCalibration(null).snapshot.version).toBe(POWER_CALIBRATION_VERSION);
    expect(normalizePersistedPowerCalibration({ version: 999, devices: {} })).toEqual({
      kind: 'loaded',
      snapshot: createEmptyPowerCalibrationSnapshot(),
    });
    expect(normalizePersistedPowerCalibration('garbage').snapshot.devices).toEqual({});
  });

  it('drops malformed device or step records but preserves valid siblings', () => {
    const { snapshot: result } = normalizePersistedPowerCalibration({
      version: POWER_CALIBRATION_VERSION,
      stepFloorApplied: true,
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
    const { snapshot: result } = normalizePersistedPowerCalibration({
      version: POWER_CALIBRATION_VERSION,
      stepFloorApplied: true,
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

  const persistedStep = (observedKw: number, nameplateAtSampleKw: number) => ({
    observedKw,
    nameplateAtSampleKw,
    samples: 100,
    sustainedSeconds: 6_000,
    lastSampleMs: 1_000,
  });

  it('drops steps learned below 80 % of their nameplate from a value without the step-floor mark', () => {
    // Written by a build before the step floor: version 1, no mark.
    const result = normalizePersistedPowerCalibration({
      version: 1,
      devices: {
        // The production 6 A rung: 0.7878 kW learned against 1.38 kW (57 %).
        elbillader: { steps: { '6a': persistedStep(0.7878, 1.38) }, lastTouchedMs: 1_000 },
        // A healthy rung at 96 % of nameplate.
        hoiax: { steps: { max: persistedStep(2.87, 3) }, lastTouchedMs: 1_000 },
      },
    });
    expect(result.kind).toBe('upgraded');
    if (result.kind !== 'upgraded') return;
    expect(result.resetSteps).toEqual([
      { deviceId: 'elbillader', stepId: '6a', observedKw: 0.7878, nameplateAtSampleKw: 1.38 },
    ]);
    expect(result.snapshot.version).toBe(POWER_CALIBRATION_VERSION);
    // The device entry survives with no steps, keeping its retention clock.
    expect(result.snapshot.devices.elbillader).toEqual({ steps: {}, lastTouchedMs: 1_000 });
    expect(result.snapshot.devices.hoiax.steps.max).toEqual(persistedStep(2.87, 3));
  });

  it('still reads a value without the mark as upgraded when nothing needs resetting', () => {
    const result = normalizePersistedPowerCalibration({
      version: 1,
      devices: { hoiax: { steps: { max: persistedStep(2.87, 3) }, lastTouchedMs: 1_000 } },
    });
    expect(result).toEqual({
      kind: 'upgraded',
      snapshot: {
        version: POWER_CALIBRATION_VERSION,
        devices: { hoiax: { steps: { max: persistedStep(2.87, 3) }, lastTouchedMs: 1_000 } },
      },
      resetSteps: [],
    });
  });

  it('never resets a step in a value carrying the mark, however low it learned', () => {
    // A single-phase car on a rung configured three-phase learns about a third
    // of nameplate under the current gates; once written back it must stay.
    const snapshot: PowerCalibrationSnapshot = {
      version: POWER_CALIBRATION_VERSION,
      devices: { elbillader: { steps: { '6a': persistedStep(1.38, 4.14) }, lastTouchedMs: 1_000 } },
    };
    const persisted = toPersistedPowerCalibrationValue(snapshot);
    expect(persisted.stepFloorApplied).toBe(true);
    // Earlier builds read only `version: 1`, so the mark must not change it.
    expect(persisted.version).toBe(1);
    expect(normalizePersistedPowerCalibration(persisted)).toEqual({ kind: 'loaded', snapshot });
  });
});

describe('mergeRecoveredCalibrationHistory', () => {
  const step = (observedKw: number, lastSampleMs: number) => ({
    observedKw,
    nameplateAtSampleKw: 3,
    samples: 6,
    sustainedSeconds: 600,
    lastSampleMs,
  });

  it('fills devices the in-memory store has not re-observed since boot', () => {
    const merged = mergeRecoveredCalibrationHistory({
      inMemory: {
        version: POWER_CALIBRATION_VERSION,
        devices: { fresh: { steps: { high: step(2.6, 2_000) }, lastTouchedMs: 2_000 } },
      },
      recovered: {
        version: POWER_CALIBRATION_VERSION,
        devices: { historic: { steps: { high: step(2.9, 1_000) }, lastTouchedMs: 1_000 } },
      },
    });
    expect(Object.keys(merged.devices).sort()).toEqual(['fresh', 'historic']);
    expect(merged.devices.historic.steps.high.observedKw).toBeCloseTo(2.9);
    expect(merged.devices.fresh.steps.high.observedKw).toBeCloseTo(2.6);
  });

  it('merges a shared device per step: in-memory wins on collision, recovered fills the rest', () => {
    // The in-memory device has only re-visited one step since boot. Recovered
    // EMAs for the other steps are exactly the history the merge preserves.
    const merged = mergeRecoveredCalibrationHistory({
      inMemory: {
        version: POWER_CALIBRATION_VERSION,
        devices: { shared: { steps: { max: step(2.6, 2_000) }, lastTouchedMs: 2_000 } },
      },
      recovered: {
        version: POWER_CALIBRATION_VERSION,
        devices: {
          shared: {
            steps: { low: step(1.1, 500), medium: step(1.6, 800), max: step(2.9, 1_000) },
            lastTouchedMs: 1_000,
          },
        },
      },
    });
    expect(Object.keys(merged.devices.shared.steps).sort()).toEqual(['low', 'max', 'medium']);
    expect(merged.devices.shared.steps.max.observedKw).toBeCloseTo(2.6);
    expect(merged.devices.shared.steps.low.observedKw).toBeCloseTo(1.1);
    expect(merged.devices.shared.lastTouchedMs).toBe(2_000);
  });

  it('returns the recovered history untouched when nothing mutated in memory', () => {
    const recovered = {
      version: POWER_CALIBRATION_VERSION,
      devices: { historic: { steps: { high: step(2.9, 1_000) }, lastTouchedMs: 1_000 } },
    };
    const merged = mergeRecoveredCalibrationHistory({
      inMemory: createEmptyPowerCalibrationSnapshot(),
      recovered,
    });
    expect(merged.devices).toEqual(recovered.devices);
  });
});
