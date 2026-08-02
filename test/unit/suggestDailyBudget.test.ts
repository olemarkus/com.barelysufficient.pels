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
  suppressedDaysExcluded: 0,
  suppressionFilterRelaxed: false,
  recentSuppressionSuspected: false,
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
    expect(result.budgetMayBeLimiting).toBe(false);
  });

  it('leans the suggestion UP (q80→q90) when the budget has recently been limiting', () => {
    const limitedFit = { ...baseFit, recentSuppressionSuspected: true };
    // 0 °C: predicted 50, headroom uses q90 (8) instead of q80 (5).
    const result = suggestDailyBudgetKwh({ fit: limitedFit, forecastMeanTempC: 0 });
    expect(result.budgetMayBeLimiting).toBe(true);
    expect(result.suggestedBudgetKwh).toBe(58);
    // Never lower than the un-leaned suggestion for the same forecast.
    const baseline = suggestDailyBudgetKwh({ fit: baseFit, forecastMeanTempC: 0 });
    expect(result.suggestedBudgetKwh).toBeGreaterThanOrEqual(baseline.suggestedBudgetKwh);
  });

  it('leans on a WARM forecast too — being limited is evidence whatever the weather', () => {
    // Regression: the lean used to require a forecast below the balance point,
    // which left it dead all summer. 18 °C is above the 15 °C balance point, so
    // the prediction is the flat base load (20) — exactly the regime where the
    // base load is extrapolated rather than observed, and least trustworthy.
    const limitedFit = { ...baseFit, recentSuppressionSuspected: true };
    const result = suggestDailyBudgetKwh({ fit: limitedFit, forecastMeanTempC: 18 });
    expect(result.budgetMayBeLimiting).toBe(true);
    expect(result.suggestedBudgetKwh).toBe(28); // 20 + q90 8, not 20 + q80 5
  });

  it('adds the budget-pressure term on top of the headroom, bounded to half the prediction', () => {
    const state = { kwh: 7, throughDateKey: '2026-07-31' };
    const result = suggestDailyBudgetKwh({ fit: baseFit, forecastMeanTempC: 0, budgetPressure: state });
    expect(result.budgetPressureKwh).toBe(7);
    expect(result.suggestedBudgetKwh).toBe(62); // 50 predicted + 5 q80 + 7 pressure

    // The ceiling is half the prediction (25 here), so a runaway term is clamped.
    const runaway = suggestDailyBudgetKwh({
      fit: baseFit, forecastMeanTempC: 0, budgetPressure: { kwh: 90, throughDateKey: '2026-07-31' },
    });
    expect(runaway.budgetPressureKwh).toBe(25);
    expect(runaway.suggestedBudgetKwh).toBe(80);
  });

  it('keeps the capacity ceiling above the pressure term, and reports what it really added', () => {
    const result = suggestDailyBudgetKwh({
      fit: baseFit,
      forecastMeanTempC: 0,
      capacityLimitKw: 2,
      budgetPressure: { kwh: 40, throughDateKey: '2026-07-31' },
    });
    expect(result.suggestedBudgetKwh).toBe(48); // 2 kW × 24 h still wins
    // Without the term the suggestion would already be 48 (55 clamped to the
    // cap), so the term contributed nothing — and the reason line must not
    // claim it did.
    expect(result.budgetPressureKwh).toBe(0);
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
