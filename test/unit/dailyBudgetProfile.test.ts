import { buildDefaultProfile } from '../../lib/dailyBudget/dailyBudgetMath';
import { getEffectiveProfileData } from '../../lib/dailyBudget/dailyBudgetProfile';

describe('daily budget profile helpers', () => {
  it('returns defaults when no learned profiles exist', () => {
    const defaultProfile = buildDefaultProfile();
    const settings = {
      enabled: true,
      dailyBudgetKWh: 10,
      priceShapingEnabled: false,
      controlledUsageWeight: 1,
      priceShapingFlexShare: 0.6,
    };

    const data = getEffectiveProfileData({}, settings, defaultProfile);
    expect(data.combinedWeights).toHaveLength(defaultProfile.length);
    data.combinedWeights.forEach((value, index) => {
      expect(value).toBeCloseTo(defaultProfile[index] ?? 0, 8);
    });
    expect(data.breakdown.controlled.every((value) => value === 0)).toBe(true);
  });

  it('keeps learned profile blending independent from reserve-mode settings', () => {
    const defaultProfile = buildDefaultProfile();
    const balancedSettings = {
      enabled: true,
      dailyBudgetKWh: 10,
      priceShapingEnabled: false,
      controlledUsageWeight: 0,
      priceShapingFlexShare: 0.6,
    };
    const conservativeSettings = {
      ...balancedSettings,
      controlledUsageWeight: 1,
    };
    const state = {
      profileUncontrolled: { weights: [1, 0, ...Array.from({ length: 22 }, () => 0)], sampleCount: 14 },
      profileControlled: { weights: [0, 1, ...Array.from({ length: 22 }, () => 0)], sampleCount: 14 },
      profileControlledShare: 0.5,
      profileSampleCount: 14,
    };

    const balanced = getEffectiveProfileData(state, balancedSettings, defaultProfile);
    const conservative = getEffectiveProfileData(state, conservativeSettings, defaultProfile);

    balanced.combinedWeights.forEach((value, index) => {
      expect(value).toBeCloseTo(conservative.combinedWeights[index] ?? 0, 8);
    });
  });
});
