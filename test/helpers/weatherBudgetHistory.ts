import type { WeatherDailyRecord } from '../../packages/contracts/src/weatherAdvisorTypes';

// A full seasonal cycle with an increase in household demand in the last week.
// Those days have reliable usage and legacy hold durations but no proof of damage.
export const createWeatherBudgetHistory = (): WeatherDailyRecord[] => (
  Array.from({ length: 365 }, (_, index) => {
    const dateKey = new Date(Date.UTC(2029, 7, index + 1)).toISOString().slice(0, 10);
    const season = Math.cos(2 * Math.PI * (index - 142) / 365);
    const tempMeanC = 11 - 7 * season + (index % 11) - 5;
    const recent = index >= 357;
    const kwhTotal = 36 + 5 * season + 2 * Math.max(0, 12 - tempMeanC) + (index % 5) + (recent ? 14 : 0);
    return {
      dateKey,
      tempMeanC,
      tempMinC: tempMeanC - 2,
      tempMaxC: tempMeanC + 2,
      tempSampleCount: 24,
      kwhTotal,
      kwhBudgetCounted: kwhTotal,
      appliedBudgetKwh: recent ? 49 : 60,
      quality: { partialTemp: false, missingKwh: false, unreliablePower: false, backfilled: false },
      ...(recent ? { suppression: { blockedByHeadroomMs: 6 * 60 * 60 * 1000 } } : {}),
    };
  })
);
