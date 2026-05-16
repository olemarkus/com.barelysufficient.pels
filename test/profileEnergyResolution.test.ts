import { progressCurrentValue } from '../lib/plan/deferredObjectives/diagnosticsBridge';
import type { DeferredObjectiveProgressResolution } from '../lib/plan/deferredObjectives/diagnosticProgress';
import { resolveProfileEnergy } from '../lib/plan/deferredObjectives/profileEnergyResolution';
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
      remainingUnits: 5,
      currentValue: 50,
    });
    expect(result.reasonCode).toBe('objective_missing_capacity');
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
