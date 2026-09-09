import { buildWeatherBudgetAdjustedTokens } from '../../setup/appInit/createWeatherCollector';

describe('buildWeatherBudgetAdjustedTokens', () => {
  it('rounds the budget to 0.1 kWh and the forecast temp to whole °C', () => {
    expect(buildWeatherBudgetAdjustedTokens({ budgetKwh: 71.96, forecastMeanTempC: -4.6 }))
      .toEqual({ budget_kwh: 72, forecast_temperature: -5 });
    expect(buildWeatherBudgetAdjustedTokens({ budgetKwh: 48.25, forecastMeanTempC: 3.2 }))
      .toEqual({ budget_kwh: 48.3, forecast_temperature: 3 });
  });

  it('returns null on a non-finite value (never fire a misleading 0)', () => {
    expect(buildWeatherBudgetAdjustedTokens({ budgetKwh: Number.NaN, forecastMeanTempC: -4 })).toBeNull();
    expect(buildWeatherBudgetAdjustedTokens({ budgetKwh: 72, forecastMeanTempC: Number.POSITIVE_INFINITY }))
      .toBeNull();
  });
});
