import { progressCurrentValue } from '../lib/plan/deferredObjectives/diagnosticsBridge';
import type { DeferredObjectiveProgressResolution } from '../lib/plan/deferredObjectives/diagnosticProgress';
import {
  resolveDisplayConfidence,
  resolveProfileEnergy,
} from '../lib/plan/deferredObjectives/profileEnergyResolution';
import type {
  DeviceObjectiveProfile,
  ObjectiveProfileBand,
  ObjectiveProfileStat,
} from '../lib/core/objectiveProfileTypes';
import type { PowerTrackerState } from '../lib/core/powerTracker';

const stat = (mean: number): ObjectiveProfileStat => ({
  sampleCount: 20,
  mean,
  m2: 0,
  min: mean,
  max: mean,
  confidence: 'high',
  lastUpdatedMs: 0,
});

const band = (
  lowerInclusive: number,
  upperExclusive: number,
  mean: number,
  sampleCount = 20,
): ObjectiveProfileBand => ({
  lowerInclusive,
  upperExclusive,
  sampleCount,
  mean,
  m2: 0,
  confidence: 'high',
});

const buildProfile = (overrides: Partial<DeviceObjectiveProfile>): DeviceObjectiveProfile => ({
  kind: 'temperature',
  updatedAtMs: 0,
  lastSample: { observedAtMs: 0, value: 50, unit: 'degree_c' },
  acceptedSamples: 20,
  rejectedSamples: 0,
  kwhPerUnit: stat(0.3),
  ...overrides,
});

const buildTracker = (profile: DeviceObjectiveProfile, deviceId = 'device-1'): PowerTrackerState => ({
  objectiveProfiles: { [deviceId]: profile },
});

describe('resolveProfileEnergy (banded)', () => {
  it('falls back to the global mean when bands are absent', () => {
    const tracker = buildTracker(buildProfile({ kwhPerUnit: stat(0.4) }));
    const result = resolveProfileEnergy({
      powerTracker: tracker,
      deviceId: 'device-1',
      objectiveKind: 'temperature',
      enforcement: 'hard',
      remainingUnits: 5,
      currentValue: 50,
    });
    expect(result.reasonCode).toBeNull();
    expect(result.energyNeededKWh).toBeCloseTo(2, 6);
    expect(result.kWhPerUnit).toBeCloseTo(0.4, 6);
  });

  it('falls back to the global mean when currentValue is not provided', () => {
    const tracker = buildTracker(buildProfile({
      kwhPerUnit: stat(0.3),
      bands: [band(30, 50, 0.1), band(50, 70, 0.9)],
    }));
    const result = resolveProfileEnergy({
      powerTracker: tracker,
      deviceId: 'device-1',
      objectiveKind: 'temperature',
      enforcement: 'hard',
      remainingUnits: 10,
    });
    expect(result.reasonCode).toBeNull();
    // Bands are present but currentValue is unknown — must not integrate.
    expect(result.energyNeededKWh).toBeCloseTo(3, 6);
  });

  it('integrates across multiple bands between current and target', () => {
    // Cheap band 30-50 (mean 0.1), expensive band 50-70 (mean 0.9).
    // Heating 45 -> 60 should consume 5 * 0.1 + 10 * 0.9 = 9.5 kWh.
    const tracker = buildTracker(buildProfile({
      kwhPerUnit: stat(0.3),
      bands: [band(30, 50, 0.1), band(50, 70, 0.9)],
    }));
    const result = resolveProfileEnergy({
      powerTracker: tracker,
      deviceId: 'device-1',
      objectiveKind: 'temperature',
      enforcement: 'hard',
      remainingUnits: 15,
      currentValue: 45,
    });
    expect(result.energyNeededKWh).toBeCloseTo(9.5, 6);
    // Effective kWh/unit is total energy divided by remainingUnits.
    expect(result.kWhPerUnit).toBeCloseTo(9.5 / 15, 6);
  });

  it('uses the global mean for portions outside the observed band range', () => {
    // Bands cover 30-50. Heating 45 -> 80 puts 5 units inside the band and
    // 30 units above the highest band edge, where we fall back to the global
    // mean (0.3). Expected: 5*0.1 + 30*0.3 = 0.5 + 9 = 9.5 kWh.
    const tracker = buildTracker(buildProfile({
      kwhPerUnit: stat(0.3),
      bands: [band(30, 50, 0.1)],
    }));
    const result = resolveProfileEnergy({
      powerTracker: tracker,
      deviceId: 'device-1',
      objectiveKind: 'temperature',
      enforcement: 'hard',
      remainingUnits: 35,
      currentValue: 45,
    });
    expect(result.energyNeededKWh).toBeCloseTo(9.5, 6);
  });

  it('uses the global mean for bands with insufficient sample count', () => {
    // Low-sample (sparse) band of mean 0.9 should not dominate the estimate;
    // its portion is replaced by the global mean (0.3). Expected for 50->70:
    // 20 * 0.3 = 6 kWh, not 20 * 0.9 = 18.
    const tracker = buildTracker(buildProfile({
      kwhPerUnit: stat(0.3),
      bands: [band(50, 70, 0.9, 1)],
    }));
    const result = resolveProfileEnergy({
      powerTracker: tracker,
      deviceId: 'device-1',
      objectiveKind: 'temperature',
      enforcement: 'hard',
      remainingUnits: 20,
      currentValue: 50,
    });
    expect(result.energyNeededKWh).toBeCloseTo(6, 6);
  });

  it('reports missing capacity when no learned profile and no bootstrap kind matches', () => {
    const tracker: PowerTrackerState = { objectiveProfiles: {} };
    const result = resolveProfileEnergy({
      powerTracker: tracker,
      deviceId: 'device-1',
      objectiveKind: 'temperature',
      enforcement: 'hard',
      remainingUnits: 5,
      currentValue: 50,
    });
    expect(result.reasonCode).toBe('objective_missing_capacity');
  });
});

describe('resolveProfileEnergy variance buffer', () => {
  // Buffer is mean + k · (σ/√n). m2 chosen via σ²·(n-1) so σ is exact; n = 4
  // keeps √n = 2 so the standard error is a round number.
  const statVar = (mean: number, sampleCount: number, sigma: number): ObjectiveProfileStat => ({
    sampleCount,
    mean,
    m2: sigma * sigma * (sampleCount - 1),
    min: mean,
    max: mean,
    confidence: 'low',
    lastUpdatedMs: 0,
  });

  it('plans against mean + k·SE for a hard objective while expected stays at the mean', () => {
    // σ = 0.2, n = 4 → SE = 0.1; hard k = 2 → rate 0.4 + 2·0.1 = 0.6.
    const tracker = buildTracker(buildProfile({ kwhPerUnit: statVar(0.4, 4, 0.2) }));
    const result = resolveProfileEnergy({
      powerTracker: tracker,
      deviceId: 'device-1',
      objectiveKind: 'temperature',
      enforcement: 'hard',
      remainingUnits: 10,
      currentValue: 50,
    });
    if (result.reasonCode !== null) throw new Error('expected a learned resolution');
    expect(result.energyExpectedKWh).toBeCloseTo(4, 6); // 10 * 0.4
    expect(result.energyNeededKWh).toBeCloseTo(6, 6); // 10 * (0.4 + 2 * 0.1)
    // Displayed learned rate stays at the measured mean, not the buffer.
    expect(result.kWhPerUnit).toBeCloseTo(0.4, 6);
  });

  it('uses a gentler k for soft objectives', () => {
    // Same SE = 0.1; soft k = 1 → rate 0.4 + 1·0.1 = 0.5.
    const tracker = buildTracker(buildProfile({ kwhPerUnit: statVar(0.4, 4, 0.2) }));
    const result = resolveProfileEnergy({
      powerTracker: tracker,
      deviceId: 'device-1',
      objectiveKind: 'temperature',
      enforcement: 'soft',
      remainingUnits: 10,
      currentValue: 50,
    });
    if (result.reasonCode !== null) throw new Error('expected a learned resolution');
    expect(result.energyNeededKWh).toBeCloseTo(5, 6); // 10 * (0.4 + 1 * 0.1)
  });

  it('shrinks the buffer as the sample count grows (standard error fades)', () => {
    // Same σ = 0.2 and mean, but n = 64 → SE = 0.2/8 = 0.025; hard k = 2 →
    // rate 0.4 + 0.05 = 0.45, far below the n = 4 case (0.6). The buffer fades
    // toward the mean with learning rather than persisting.
    const tracker = buildTracker(buildProfile({ kwhPerUnit: statVar(0.4, 64, 0.2) }));
    const result = resolveProfileEnergy({
      powerTracker: tracker,
      deviceId: 'device-1',
      objectiveKind: 'temperature',
      enforcement: 'hard',
      remainingUnits: 10,
      currentValue: 50,
    });
    if (result.reasonCode !== null) throw new Error('expected a learned resolution');
    expect(result.energyNeededKWh).toBeCloseTo(4.5, 6); // 10 * (0.4 + 2 * 0.025)
  });

  it('does not buffer during cold-start (sample count below the floor)', () => {
    const tracker = buildTracker(buildProfile({ kwhPerUnit: statVar(0.4, 3, 0.2) }));
    const result = resolveProfileEnergy({
      powerTracker: tracker,
      deviceId: 'device-1',
      objectiveKind: 'temperature',
      enforcement: 'hard',
      remainingUnits: 10,
      currentValue: 50,
    });
    if (result.reasonCode !== null) throw new Error('expected a learned resolution');
    // Range collapses: planned == expected when the estimate is not yet trustworthy.
    expect(result.energyNeededKWh).toBeCloseTo(4, 6);
    expect(result.energyExpectedKWh).toBeCloseTo(4, 6);
  });

  it('caps the buffer so a pathological estimate cannot explode the booked energy', () => {
    // σ = 1.0, n = 4 → SE = 0.5; hard k = 2 → mean + 1.0 = 1.4, capped at 2× mean = 0.8.
    const tracker = buildTracker(buildProfile({ kwhPerUnit: statVar(0.4, 4, 1) }));
    const result = resolveProfileEnergy({
      powerTracker: tracker,
      deviceId: 'device-1',
      objectiveKind: 'temperature',
      enforcement: 'hard',
      remainingUnits: 10,
      currentValue: 50,
    });
    if (result.reasonCode !== null) throw new Error('expected a learned resolution');
    expect(result.energyNeededKWh).toBeCloseTo(8, 6); // 10 * min(1.4, 0.8)
  });

  it('buffers per band using each band own standard error', () => {
    // Band: σ = 0.4, n = 4 → SE = 0.2; hard k = 2 → rate 0.5 + 0.4 = 0.9.
    const tracker = buildTracker(buildProfile({
      kwhPerUnit: statVar(0.3, 20, 0.05),
      bands: [{ lowerInclusive: 50, upperExclusive: 70, sampleCount: 4, mean: 0.5, m2: 0.4 * 0.4 * 3, confidence: 'low' }],
    }));
    const result = resolveProfileEnergy({
      powerTracker: tracker,
      deviceId: 'device-1',
      objectiveKind: 'temperature',
      enforcement: 'hard',
      remainingUnits: 20,
      currentValue: 50,
    });
    if (result.reasonCode !== null) throw new Error('expected a learned resolution');
    expect(result.energyExpectedKWh).toBeCloseTo(10, 6); // 20 * 0.5
    expect(result.energyNeededKWh).toBeCloseTo(18, 6); // 20 * (0.5 + 2 * 0.2)
  });
});

describe('progressCurrentValue', () => {
  const okProgress = (
    overrides: Partial<DeferredObjectiveProgressResolution>,
  ): DeferredObjectiveProgressResolution => ({
    remainingUnits: 5,
    currentPercent: null,
    currentTemperatureC: null,
    reasonCode: null,
    ...overrides,
  });

  it('returns currentPercent for ev_soc objectives', () => {
    expect(progressCurrentValue({
      progress: okProgress({ currentPercent: 65 }),
      objectiveKind: 'ev_soc',
    })).toBe(65);
  });

  it('returns currentTemperatureC for temperature objectives', () => {
    expect(progressCurrentValue({
      progress: okProgress({ currentTemperatureC: 55 }),
      objectiveKind: 'temperature',
    })).toBe(55);
  });

  it('returns undefined for generic_energy (no banded path)', () => {
    expect(progressCurrentValue({
      progress: okProgress({ currentTemperatureC: 55 }),
      objectiveKind: 'generic_energy',
    })).toBeUndefined();
  });

  it('returns undefined when progress has a reasonCode', () => {
    expect(progressCurrentValue({
      progress: {
        remainingUnits: 0,
        currentPercent: 50,
        currentTemperatureC: null,
        reasonCode: 'objective_progress_stale',
      },
      objectiveKind: 'ev_soc',
    })).toBeUndefined();
  });

  it('returns undefined when the relevant value is missing', () => {
    expect(progressCurrentValue({
      progress: okProgress({ currentPercent: null }),
      objectiveKind: 'ev_soc',
    })).toBeUndefined();
  });
});

describe('resolveDisplayConfidence (band-aware)', () => {
  it('falls back to the global confidence when bands are absent', () => {
    expect(resolveDisplayConfidence({
      bands: undefined,
      globalConfidence: 'low',
      remainingUnits: 5,
      currentValue: 50,
    })).toBe('low');
  });

  it('falls back to global when currentValue is missing', () => {
    expect(resolveDisplayConfidence({
      bands: [band(40, 60, 0.3, 20)],
      globalConfidence: 'medium',
      remainingUnits: 5,
      currentValue: undefined,
    })).toBe('medium');
  });

  it('falls back to global when remainingUnits is non-positive', () => {
    expect(resolveDisplayConfidence({
      bands: [band(40, 60, 0.3, 20)],
      globalConfidence: 'high',
      remainingUnits: 0,
      currentValue: 50,
    })).toBe('high');
  });

  it('falls back to global when an overlapping band is underpopulated', () => {
    // 3 samples is below MIN_BAND_SAMPLES_FOR_INTEGRATION (4) — the model
    // would lean on the global mean for that slice, so confidence isn't
    // band-aware-trustworthy.
    expect(resolveDisplayConfidence({
      bands: [band(40, 60, 0.3, 3)],
      globalConfidence: 'low',
      remainingUnits: 5,
      currentValue: 50,
    })).toBe('low');
  });

  it('falls back to global when bands leave the interval partially uncovered', () => {
    // Bands cover [40, 60) but the integration interval is [50, 70). The
    // upper half [60, 70) sits outside any band → fall back.
    expect(resolveDisplayConfidence({
      bands: [band(40, 60, 0.3, 20)],
      globalConfidence: 'low',
      remainingUnits: 20,
      currentValue: 50,
    })).toBe('low');
  });

  it('aggregates over fully-covered qualifying bands taking the minimum', () => {
    // Integration over [50, 70) crosses two adjacent bands; min(high, medium)
    // = medium.
    const result = resolveDisplayConfidence({
      bands: [
        { lowerInclusive: 40, upperExclusive: 60, sampleCount: 20, mean: 0.3, m2: 0, confidence: 'high' },
        { lowerInclusive: 60, upperExclusive: 80, sampleCount: 20, mean: 0.5, m2: 0, confidence: 'medium' },
      ],
      globalConfidence: 'low',
      remainingUnits: 20,
      currentValue: 50,
    });
    expect(result).toBe('medium');
  });

  it('regression: thermal pattern with global low but every band medium+ returns medium', () => {
    // Classic complaint: thousands of samples on a thermostat, global CV
    // forces `low`, but bands are individually tight. The chip should reflect
    // band quality, not the global noise floor.
    const result = resolveDisplayConfidence({
      bands: [
        { lowerInclusive: 40, upperExclusive: 50, sampleCount: 60, mean: 0.55, m2: 0, confidence: 'medium' },
        { lowerInclusive: 50, upperExclusive: 60, sampleCount: 80, mean: 0.38, m2: 0, confidence: 'high' },
        { lowerInclusive: 60, upperExclusive: 70, sampleCount: 50, mean: 0.62, m2: 0, confidence: 'medium' },
      ],
      globalConfidence: 'low',
      remainingUnits: 30,
      currentValue: 40,
    });
    expect(result).toBe('medium');
  });
});

describe('resolveProfileEnergy displayConfidence', () => {
  it('exposes a band-aware displayConfidence on the learned resolution', () => {
    const tracker = buildTracker(buildProfile({
      kwhPerUnit: { ...stat(0.4), confidence: 'low' },
      bands: [
        { lowerInclusive: 40, upperExclusive: 60, sampleCount: 20, mean: 0.4, m2: 0, confidence: 'high' },
      ],
    }));
    const result = resolveProfileEnergy({
      powerTracker: tracker,
      deviceId: 'device-1',
      objectiveKind: 'temperature',
      enforcement: 'hard',
      remainingUnits: 5,
      currentValue: 50,
    });
    expect(result.reasonCode).toBeNull();
    if (result.reasonCode !== null) return;
    expect(result.rateConfidence).toBe('low');
    expect(result.displayConfidence).toBe('high');
  });

  it('returns null displayConfidence on the EV bootstrap path', () => {
    const tracker: PowerTrackerState = { objectiveProfiles: {} };
    const result = resolveProfileEnergy({
      powerTracker: tracker,
      deviceId: 'device-1',
      objectiveKind: 'ev_soc',
      enforcement: 'hard',
      remainingUnits: 20,
      currentValue: 40,
    });
    expect(result.reasonCode).toBeNull();
    if (result.reasonCode !== null) return;
    expect(result.kwhPerUnitSource).toBe('bootstrap');
    expect(result.displayConfidence).toBeNull();
  });
});
