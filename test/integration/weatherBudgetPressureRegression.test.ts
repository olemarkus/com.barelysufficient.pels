import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { WeatherDailyRecord } from '../../packages/contracts/src/weatherAdvisorTypes';
import { fitEnergySignature } from '../../packages/shared-domain/src/energySignature/energySignature';
import { suggestDailyBudgetKwh } from '../../lib/weather/suggestDailyBudget';
import { foldBudgetPressureDay } from '../../packages/shared-domain/src/energySignature/budgetPressure';

/**
 * The real failure, replayed.
 *
 * On 2026-08-01 a production home auto-applied a 44.1 kWh daily budget while its
 * actual demand was ~50 kWh. The daily budget — not the capacity cap, which sat
 * unused at 8–10 kW — was the binding pace constraint in 92% of plan rebuilds,
 * and 33 of 34 starvation episodes that day carried `cause: daily_budget`.
 *
 * The fixture is that home's `weather_history_state`, redacted to the fields the
 * fit and suggestion actually read. It contains a two-week away stretch
 * (2026-07-10 → 07-23, 10–13 kWh/day with no managed use) sitting inside the
 * 365-day window as ordinary warm-regime observations, which is what dragged the
 * base load down to 35.7 kWh against a ~50 kWh reality.
 *
 * Legacy headroom totals do not establish unresolved budget damage. The new
 * policy instead learns from recent actual residuals and measured overshoot.
 */

// Resolved from the project root (vitest's cwd) rather than `import.meta.url`:
// the tests tsconfig emits CommonJS, where `import.meta` is not available.
const FIXTURE_PATH = resolve(process.cwd(), 'test/fixtures/weatherHistoryProduction.json');
const records = (JSON.parse(readFileSync(FIXTURE_PATH, 'utf8')) as { records: WeatherDailyRecord[] }).records;

/** Local midnight of 2026-08-01 in the home's timezone — when the rollup ran. */
const NOW_MS = Date.parse('2026-08-01T00:05:00Z');
/** The MET forecast mean the app logged for the target day. */
const FORECAST_MEAN_C = 13.57;
/** What the home actually drew on the two closed days either side of the decision. */
const OBSERVED_DEMAND_KWH = 49.99;

/**
 * The fixture predates `kwhBudgetCounted`, so the loop would measure no balance
 * on it at all. Replay it as a home with no budget-exempt load, where the
 * budget-counted axis and the whole-home total coincide.
 */
const withoutExemptLoad = (record: WeatherDailyRecord): WeatherDailyRecord => (
  record.kwhTotal === undefined ? record : { ...record, kwhBudgetCounted: record.kwhTotal }
);

const foldClosedDays = (fromDateKey: string) => {
  let state;
  for (const record of records.filter((entry) => entry.dateKey >= fromDateKey)) {
    state = foldBudgetPressureDay(state, withoutExemptLoad(record));
  }
  return state;
};

describe('2026-08-01 under-budget regression (real production history)', () => {
  it('reproduces the model that under-predicted the day', () => {
    const fit = fitEnergySignature(records, NOW_MS);
    if (!fit) throw new Error('expected a fit');
    // The extrapolated warm-regime base load, ~14 kWh under what the home used
    // on the two comparable days that bracket the decision (51.6 and 50.0).
    expect(fit.baseLoadKwhPerDay).toBeCloseTo(35.7, 1);
    expect(fit.balancePointC).toBe(13);
    // Above the balance point, so the whole heating term is zero and the
    // prediction IS the base load — the case the old cold-gated lean ignored.
    expect(FORECAST_MEAN_C).toBeGreaterThan(fit.balancePointC as number);
  });

  it('does not infer unresolved budget damage from legacy hold durations', () => {
    const fit = fitEnergySignature(records, NOW_MS);
    // The archived fields cannot establish cause or subsequent recovery.
    expect(fit?.recentSuppressionSuspected).toBe(false);
    expect(fit?.recentResidualQ80).toBeGreaterThan(fit?.residualQ80 ?? 0);
  });

  it('suggests at least what the home actually used, instead of the 44.1 kWh that starved it', () => {
    const fit = fitEnergySignature(records, NOW_MS);
    if (!fit) throw new Error('expected a fit');
    const result = suggestDailyBudgetKwh({
      fit,
      forecastMeanTempC: FORECAST_MEAN_C,
      budgetPressure: foldClosedDays('2026-07-24'),
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
    // Disable recent calibration to reproduce the original annual-only advice.
    const fit = fitEnergySignature(records, NOW_MS);
    if (!fit) throw new Error('expected a fit');
    const asShipped = suggestDailyBudgetKwh({
      fit: { ...fit, recentSuppressionSuspected: false,
        recentResidualQ80: undefined, recentResidualQ90: undefined },
      forecastMeanTempC: FORECAST_MEAN_C,
    });
    expect(asShipped.suggestedBudgetKwh).toBeCloseTo(44.1, 1);
    expect(asShipped.suggestedBudgetKwh).toBeLessThan(OBSERVED_DEMAND_KWH);
    expect(suggestDailyBudgetKwh({ fit, forecastMeanTempC: FORECAST_MEAN_C })
      .suggestedBudgetKwh).toBeGreaterThan(OBSERVED_DEMAND_KWH);
  });

  it('releases the pressure term once the home stops running past its budget', () => {
    const fit = fitEnergySignature(records, NOW_MS);
    if (!fit) throw new Error('expected a fit');
    let pressure = foldClosedDays('2026-07-24');
    const budgets: number[] = [];
    // Eight days where the home draws its true demand and no longer overshoots.
    for (let index = 1; index <= 8; index += 1) {
      const budget = suggestDailyBudgetKwh({
        fit,
        forecastMeanTempC: FORECAST_MEAN_C,
        budgetPressure: pressure,
      }).suggestedBudgetKwh;
      budgets.push(budget);
      pressure = foldBudgetPressureDay(pressure, {
        dateKey: `2026-08-${String(index + 1).padStart(2, '0')}`,
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
describe('2026-08-08 under the day-close damage model (real production numbers)', () => {
  const CARRIED = { kwh: 3.1640625, throughDateKey: '2026-08-07' };
  const augEighth = (suppression: WeatherDailyRecord['suppression']): WeatherDailyRecord => ({
    dateKey: '2026-08-08',
    tempMeanC: 12.749999999999998,
    tempMinC: 11,
    tempMaxC: 15,
    tempSampleCount: 24,
    kwhTotal: 62.83023596083332,
    kwhBudgetCounted: 62.83023596083332,
    appliedBudgetKwh: 60.719406746659125,
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
    expect(folded.kwh).toBeCloseTo(CARRIED.kwh + 2.1108292141741956, 9);
  });

  it('grows when the day instead ends with a device still denied', () => {
    // Hypothetical: hovedbad still latched at midnight with 2 h of denied time
    // at its 1.14 kW draw.
    const folded = foldBudgetPressureDay(CARRIED, augEighth({
      budgetDenialObserved: true,
      budgetDeniedKwh: 2.28,
      budgetUnservedKwh: 2.28,
      budgetDeniedMs: 2 * 60 * 60 * 1000,
    }));
    // Denied energy plus the measured 2.11 kWh overshoot.
    expect(folded.kwh).toBeCloseTo(CARRIED.kwh + 2.28 + 2.1108292141741956, 9);
  });

  it('does not grow on whole-home usage over the budget that was budget-exempt', () => {
    // Same day, but 4 kWh of it came from a budget-exempt device: the budget
    // counted 58.83 against 60.72, so there is no overshoot to correct and the
    // unused allowance unwinds the carried term instead.
    const folded = foldBudgetPressureDay(CARRIED, {
      ...augEighth({ budgetDenialObserved: true, budgetDeniedKwh: 0, budgetUnservedKwh: 0 }),
      kwhBudgetCounted: 62.83023596083332 - 4,
    });
    const spare = 60.719406746659125 - (62.83023596083332 - 4);
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
    // Credit 2.72 kWh of unused allowance against the 3.42 kWh pending denial.
    expect(folded.kwh).toBeCloseTo(CARRIED.kwh + 3.42 + 58 - 60.719406746659125, 9);
  });
});
