import type { WeatherDailyRecord } from '../../packages/contracts/src/weatherAdvisorTypes';
import { fitEnergySignature, predictDailyKwh } from '../../packages/shared-domain/src/energySignature/energySignature';
import { suggestDailyBudgetKwh } from '../../lib/weather/suggestDailyBudget';
import { getLogger } from '../../lib/logging/logger';
import { normalizeWeatherHistoryState } from '../../lib/weather/weatherHistory';
import { computeEnergySignatureUpdate } from '../../lib/weather/energySignatureService';
import { performBudgetAutoApply } from '../../lib/weather/weatherAutoApply';
import { foldBudgetPressureDay } from '../../packages/shared-domain/src/energySignature/budgetPressure';
import { capacityOnlyPowerLimits } from '../helpers/powerLimitSettings';
import { createWeatherBudgetHistory } from '../helpers/weatherBudgetHistory';

const records = createWeatherBudgetHistory();
const NOW_MS = Date.parse('2030-08-01T00:05:00Z');
const FORECAST_MEAN_C = 15;
const TARGET_DATE_KEY = '2030-08-01';
const OBSERVED_DEMAND_KWH = 47;

const foldClosedDays = (fromDateKey: string) => {
  let state;
  for (const record of records.filter((entry) => entry.dateKey >= fromDateKey)) {
    state = foldBudgetPressureDay(state, record);
  }
  return state;
};

describe('Daily budget underprediction and recovery', () => {
  it('applies freshly recomputed advice without an inherited whole-home correction after upgrade', () => {
    const logger = getLogger('weather/upgrade-test');
    const deps = {
      getNowMs: () => NOW_MS, getTimeZone: () => 'Europe/Oslo',
      getPowerLimitSettings: () => capacityOnlyPowerLimits(10), logger,
    };
    const original = computeEnergySignatureUpdate({ records }, deps);
    const suggestion = original.latestSuggestion;
    if (!suggestion) throw new Error('expected the fixture to yield advice');
    const migrated = normalizeWeatherHistoryState({
      ...original,
      budgetPressure: { algorithmVersion: 2, kwh: 10, throughDateKey: '2030-07-31' },
      latestSuggestion: {
        ...suggestion, budgetPressureKwh: 10, suggestedBudgetKwh: suggestion.suggestedBudgetKwh + 10,
      },
    });
    if (!migrated) throw new Error('expected history to survive migration');
    const applySuggestedDailyBudget = vi.fn(() => true);
    const applyDeps = {
      getSettings: () => ({ enabled: true, autoApplyDailyBudget: true }),
      getNowMs: deps.getNowMs, getTimeZone: deps.getTimeZone,
      getPowerLimitSettings: deps.getPowerLimitSettings, applySuggestedDailyBudget, logger,
      getAppliedDailyBudgetKwh: (): number | undefined => undefined,
      onDailyBudgetAutoApplied: () => undefined,
      recordBudgetDecision: () => undefined,
    };
    performBudgetAutoApply(migrated, applyDeps);
    expect(applySuggestedDailyBudget).not.toHaveBeenCalled();
    const updated = computeEnergySignatureUpdate(migrated, deps);
    const applied = performBudgetAutoApply(updated, applyDeps);
    expect(updated.latestSuggestion?.budgetPressureKwh).toBe(0);
    expect(applySuggestedDailyBudget).toHaveBeenCalledExactlyOnceWith(suggestion.suggestedBudgetKwh);
    expect(applied.lastAutoApply?.kwh).toBe(suggestion.suggestedBudgetKwh);
    expect(migrated.records).toEqual(original.records);
  });

  it('predicts less than the observed demand on a warm day after usage rises', () => {
    const fit = fitEnergySignature(records, NOW_MS);
    if (!fit) throw new Error('expected a fit');
    expect(fit.seasonKwh).toBeGreaterThan(0);
    expect(FORECAST_MEAN_C).toBeGreaterThan(fit.balancePointC as number);
    expect(predictDailyKwh(fit, FORECAST_MEAN_C, TARGET_DATE_KEY)).toBeLessThan(OBSERVED_DEMAND_KWH);
  });

  it('does not infer unresolved budget damage from legacy hold durations', () => {
    const fit = fitEnergySignature(records, NOW_MS);
    // The archived fields cannot establish cause or subsequent recovery.
    expect(fit?.recentSuppressionSuspected).toBe(false);
    expect(fit?.recentResidualQ80).toBeGreaterThan(fit?.residualQ80 ?? 0);
  });

  it('uses measured overshoot to suggest an allowance above observed demand', () => {
    const fit = fitEnergySignature(records, NOW_MS);
    if (!fit) throw new Error('expected a fit');
    const result = suggestDailyBudgetKwh({
      fit,
      targetDateKey: TARGET_DATE_KEY,
      forecastMeanTempC: FORECAST_MEAN_C,
      budgetPressure: foldClosedDays('2030-07-24'),
    });

    expect(result.budgetMayBeLimiting).toBe(false);
    expect(result.budgetPressureKwh).toBeGreaterThan(0);
    // The load-bearing assertion: never again below what the home demonstrably
    // drew WHILE being held back — that draw is a lower bound on true demand.
    expect(result.suggestedBudgetKwh).toBeGreaterThan(OBSERVED_DEMAND_KWH);
    // ...and still bounded, not a runaway.
    expect(result.suggestedBudgetKwh).toBeLessThan(2 * OBSERVED_DEMAND_KWH);
  });

  it('recent headroom alone covers the recorded demand where annual headroom fell short', () => {
    const fit = fitEnergySignature(records, NOW_MS);
    if (!fit) throw new Error('expected a fit');
    const annualOnly = suggestDailyBudgetKwh({
      fit: { ...fit, recentSuppressionSuspected: false,
        recentResidualQ80: undefined, recentResidualQ90: undefined },
      targetDateKey: TARGET_DATE_KEY,
      forecastMeanTempC: FORECAST_MEAN_C,
    });
    expect(annualOnly.suggestedBudgetKwh).toBeLessThan(OBSERVED_DEMAND_KWH);
    expect(suggestDailyBudgetKwh({ fit, targetDateKey: TARGET_DATE_KEY, forecastMeanTempC: FORECAST_MEAN_C })
      .suggestedBudgetKwh).toBeGreaterThan(OBSERVED_DEMAND_KWH);
  });

  it('releases the pressure term once the home stops running past its budget', () => {
    const fit = fitEnergySignature(records, NOW_MS);
    if (!fit) throw new Error('expected a fit');
    let pressure = foldClosedDays('2030-07-24');
    const budgets: number[] = [];
    // Eight days where the home draws its true demand and no longer overshoots.
    for (let index = 1; index <= 8; index += 1) {
      const budget = suggestDailyBudgetKwh({
        fit,
        targetDateKey: TARGET_DATE_KEY,
        forecastMeanTempC: FORECAST_MEAN_C,
        budgetPressure: pressure,
      }).suggestedBudgetKwh;
      budgets.push(budget);
      pressure = foldBudgetPressureDay(pressure, {
        dateKey: `2030-08-${String(index + 1).padStart(2, '0')}`,
        kwhTotal: Math.min(OBSERVED_DEMAND_KWH, budget),
        kwhBudgetCounted: Math.min(OBSERVED_DEMAND_KWH, budget),
        appliedBudgetKwh: budget,
        tempMeanC: 13.5,
        tempMinC: 11,
        tempMaxC: 16,
        tempSampleCount: 24,
        quality: {
          partialTemp: false, missingKwh: false, unreliablePower: false, backfilled: false,
        },
        suppression: { blockedByHeadroomMs: 6 * 60 * 60 * 1000 },
      });
    }
    // Monotonically relaxing — a leaky integrator, not a ratchet.
    expect(budgets[budgets.length - 1]).toBeLessThan(budgets[0]);
    // ...but it never falls back below what the home actually needs.
    expect(budgets[budgets.length - 1]).toBeGreaterThanOrEqual(OBSERVED_DEMAND_KWH - 1);
  });
});

/** Production overshoot corrects allowance; only unresolved budget denial selects q90. */
describe('Budget pressure at day close', () => {
  const CARRIED = { algorithmVersion: 3 as const, kwh: 3, throughDateKey: '2030-08-07' };
  const augEighth = (suppression: WeatherDailyRecord['suppression']): WeatherDailyRecord => ({
    dateKey: '2030-08-08',
    tempMeanC: 13,
    tempMinC: 11,
    tempMaxC: 15,
    tempSampleCount: 24,
    kwhTotal: 63,
    kwhBudgetCounted: 63,
    appliedBudgetKwh: 61,
    quality: {
      partialTemp: false, missingKwh: false, unreliablePower: false, backfilled: false,
    },
    suppression,
  });

  it('corrects measured overshoot even when every held device recovered', () => {
    // Watched to the close, nothing denied: the verdict is an explicit zero even
    // though devices were held (and served) for hours during the day.
    const folded = foldBudgetPressureDay(CARRIED, augEighth({
      budgetDenialObserved: true,
      budgetDeniedKwh: 0,
      budgetUnservedKwh: 0,
      budgetDeniedMs: 0,
      blockedByHeadroomMs: 6 * 60 * 60 * 1000,
    }));
    expect(folded.kwh).toBeCloseTo(CARRIED.kwh + 2, 9);
  });

  it('grows when the day instead ends with a device still denied', () => {
    // A heater remains latched at midnight with 2 h of denied time
    // at its 1.14 kW draw.
    const folded = foldBudgetPressureDay(CARRIED, augEighth({
      budgetDenialObserved: true,
      budgetDeniedKwh: 2.28,
      budgetUnservedKwh: 2.28,
      budgetDeniedMs: 2 * 60 * 60 * 1000,
    }));
    // Denied energy plus the measured 2 kWh overshoot.
    expect(folded.kwh).toBeCloseTo(CARRIED.kwh + 2.28 + 2, 9);
  });

  it('does not grow on whole-home usage over the budget that was budget-exempt', () => {
    // Same day, but 4 kWh of it came from a budget-exempt device: the budget
    // counted 59 against 61, so there is no overshoot to correct and the
    // unused allowance unwinds the carried term instead.
    const folded = foldBudgetPressureDay(CARRIED, {
      ...augEighth({ budgetDenialObserved: true, budgetDeniedKwh: 0, budgetUnservedKwh: 0 }),
      kwhBudgetCounted: 63 - 4,
    });
    const spare = 61 - (63 - 4);
    expect(folded.kwh).toBeCloseTo(CARRIED.kwh * 0.75 - spare, 9);
    expect(folded.kwh).toBeLessThan(CARRIED.kwh);
  });

  it('grows on a denial day the budget kept UNDER its number — invisible to the old step', () => {
    const folded = foldBudgetPressureDay(CARRIED, {
      ...augEighth({
        budgetDenialObserved: true,
        budgetDeniedKwh: 3.42,
        budgetUnservedKwh: 3.42,
        budgetDeniedMs: 3 * 60 * 60 * 1000,
      }),
      kwhTotal: 58,
      kwhBudgetCounted: 58,
    });
    // Credit 3 kWh of unused allowance against the 3.42 kWh pending denial.
    expect(folded.kwh).toBeCloseTo(CARRIED.kwh + 3.42 + 58 - 61, 9);
  });
});
