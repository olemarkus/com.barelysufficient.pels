import { buildDefaultProfile } from '../lib/dailyBudget/dailyBudgetMath';
import { getEffectiveProfileData } from '../lib/dailyBudget/dailyBudgetProfile';

describe('daily budget profile helpers', () => {
  it('returns defaults when no learned profiles exist', () => {
    const defaultProfile = buildDefaultProfile();
    const settings = {
      enabled: true,
      dailyBudgetKWh: 10,
      priceShapingEnabled: false,
      controlledUsageWeight: 1,
      priceShapingFlexShare: 0.35,
    };

    const data = getEffectiveProfileData({}, settings, defaultProfile);
    expect(data.combinedWeights).toHaveLength(defaultProfile.length);
    data.combinedWeights.forEach((value, index) => {
      expect(value).toBeCloseTo(defaultProfile[index] ?? 0, 8);
    });
    expect(data.breakdown.controlled.every((value) => value === 0)).toBe(true);
  });

  it('falls back safely when the combined denominator is zero', () => {
    const defaultProfile = buildDefaultProfile();
    const settings = {
      enabled: true,
      dailyBudgetKWh: 10,
      priceShapingEnabled: false,
      controlledUsageWeight: 0,
      priceShapingFlexShare: 0.35,
    };
    const state = {
      profileUncontrolled: { weights: Array.from({ length: 24 }, () => 0), sampleCount: 1 },
      profileControlled: { weights: Array.from({ length: 24 }, () => 0), sampleCount: 1 },
      profileControlledShare: 1,
      profileSampleCount: 1,
    };

    const data = getEffectiveProfileData(state, settings, defaultProfile);
    expect(data.combinedWeights).toHaveLength(defaultProfile.length);
    data.combinedWeights.forEach((value, index) => {
      expect(value).toBeCloseTo(defaultProfile[index] ?? 0, 8);
    });
    expect(data.breakdown.controlled.every((value) => value === 0)).toBe(true);
    expect(data.controlledShare).toBe(1);
  });
});
