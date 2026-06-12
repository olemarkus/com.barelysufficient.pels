import type { EnergySignatureFit } from '../../packages/contracts/src/weatherAdvisorTypes';
import { suggestDailyBudgetKwh } from '../../packages/shared-domain/src/energySignature/suggestDailyBudget';

const baseFit: EnergySignatureFit = {
  model: 'changepoint',
  baseLoadKwhPerDay: 20,
  balancePointC: 15,
  slopeKwhPerDegree: 2,
  pseudoR2: 0.8,
  usableDays: 120,
  observedTempMinC: -8,
  observedTempMaxC: 20,
  medianDayKwh: 40,
  lowObservedDayKwh: 18,
  confidence: 'high',
  curvatureSteeperWhenCold: false,
  driftSuspected: false,
  residualQ10: -4,
  residualQ50: 0,
  residualQ80: 5,
  residualQ90: 8,
  fittedAtMs: 0,
};

describe('suggestDailyBudgetKwh', () => {
  it('adds q80 headroom to the prediction and reports the q10–q90 band', () => {
    // 0 °C: 20 + 2×15 = 50 kWh predicted.
    const result = suggestDailyBudgetKwh({ fit: baseFit, forecastMeanTempC: 0 });
    expect(result.predictedKwh).toBe(50);
    expect(result.suggestedBudgetKwh).toBe(55);
    expect(result.predictedLowKwh).toBe(46);
    expect(result.predictedHighKwh).toBe(58);
    expect(result.beyondObservedCold).toBe(false);
  });

  it('refuses to extrapolate below observed temperatures and flags it', () => {
    const result = suggestDailyBudgetKwh({ fit: baseFit, forecastMeanTempC: -15 });
    // Evaluated at −8 (coldest observed), not −15.
    expect(result.predictedKwh).toBe(20 + 2 * 23);
    expect(result.beyondObservedCold).toBe(true);
    expect(result.beyondObservedWarm).toBe(false);
  });

  it('refuses to extrapolate above observed temperatures (winter-only linear fit, spring day)', () => {
    const winterFit: EnergySignatureFit = {
      ...baseFit,
      model: 'linear',
      baseLoadKwhPerDay: undefined,
      balancePointC: undefined,
      interceptKwhAtZeroC: 65,
      slopeKwhPerDegree: 3,
      observedTempMinC: -15,
      observedTempMaxC: -4,
      lowObservedDayKwh: 75,
      medianDayKwh: 90,
    };
    const result = suggestDailyBudgetKwh({ fit: winterFit, forecastMeanTempC: 25 });
    // Evaluated at −4 (warmest observed): 65 + 3×4 — never a negative
    // prediction from descending an unbounded line.
    expect(result.predictedKwh).toBe(77);
    expect(result.beyondObservedWarm).toBe(true);
    expect(result.predictedKwh).toBeGreaterThan(0);
    expect(result.predictedHighKwh).toBeGreaterThanOrEqual(result.predictedLowKwh);
  });

  it('caps at the capacity ceiling and clamps to the daily-budget bounds', () => {
    const capped = suggestDailyBudgetKwh({ fit: baseFit, forecastMeanTempC: -8, capacityLimitKw: 2 });
    expect(capped.suggestedBudgetKwh).toBe(48); // 2 kW × 24 h
    // The physical cap outranks the 20 kWh setting minimum.
    const tinyCap = suggestDailyBudgetKwh({ fit: baseFit, forecastMeanTempC: -8, capacityLimitKw: 0.5 });
    expect(tinyCap.suggestedBudgetKwh).toBe(12);
    const warmFit = { ...baseFit, baseLoadKwhPerDay: 6, medianDayKwh: 7, lowObservedDayKwh: 5, residualQ80: 0.2 };
    const floor = suggestDailyBudgetKwh({ fit: warmFit, forecastMeanTempC: 20 });
    expect(floor.suggestedBudgetKwh).toBe(20); // MIN_DAILY_BUDGET_KWH
  });

  it('never suggests below the home-demonstrated q05 floor', () => {
    const fit = { ...baseFit, residualQ80: -10 }; // pathological residuals
    const result = suggestDailyBudgetKwh({ fit, forecastMeanTempC: 14 });
    // Prediction 22, q80 headroom negative → 5% relative headroom keeps it
    // above; q05 floor (18 kWh) is the backstop.
    expect(result.suggestedBudgetKwh).toBeGreaterThanOrEqual(20);
  });

  it('anchors on the median day when the fit is uncorrelated', () => {
    const fit: EnergySignatureFit = { ...baseFit, model: 'uncorrelated', baseLoadKwhPerDay: undefined, balancePointC: undefined };
    const result = suggestDailyBudgetKwh({ fit, forecastMeanTempC: 0 });
    expect(result.predictedKwh).toBe(40);
  });
});
