import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { WeatherDailyRecord } from '../../packages/contracts/src/weatherAdvisorTypes';
import { fitEnergySignature } from '../../packages/shared-domain/src/energySignature/energySignature';
import { suggestDailyBudgetKwh } from '../../packages/shared-domain/src/energySignature/suggestDailyBudget';
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
 * `blockedByHeadroomMs` stands in for what the fixed build records: the
 * running build had no budget-attributed field, and the logs show 33 of 34
 * episodes were budget-caused, so the headroom total is the faithful value.
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

const foldClosedDays = (fromDateKey: string) => {
  let state;
  for (const record of records.filter((entry) => entry.dateKey >= fromDateKey)) {
    state = foldBudgetPressureDay(state, record);
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

  it('now detects the suppression the old cold gate hid', () => {
    const fit = fitEnergySignature(records, NOW_MS);
    // The home was throttled every day for a week at 12–15 °C. The old detector
    // required a day below the 13 °C knee AND a forecast below it, so this read
    // false and the correction never fired.
    expect(fit?.recentSuppressionSuspected).toBe(true);
  });

  it('suggests at least what the home actually used, instead of the 44.1 kWh that starved it', () => {
    const fit = fitEnergySignature(records, NOW_MS);
    if (!fit) throw new Error('expected a fit');
    const result = suggestDailyBudgetKwh({
      fit,
      forecastMeanTempC: FORECAST_MEAN_C,
      budgetPressure: foldClosedDays('2026-07-24'),
    });

    expect(result.budgetMayBeLimiting).toBe(true);
    expect(result.budgetPressureKwh).toBeGreaterThan(0);
    // The load-bearing assertion: never again below what the home demonstrably
    // drew WHILE being held back — that draw is a lower bound on true demand.
    expect(result.suggestedBudgetKwh).toBeGreaterThan(OBSERVED_DEMAND_KWH);
    // ...and still bounded, not a runaway.
    expect(result.suggestedBudgetKwh).toBeLessThan(2 * OBSERVED_DEMAND_KWH);
  });

  it('would have suggested the starving 44.1 kWh with every correction switched off', () => {
    // Pins the diagnosis itself: without the lean and the pressure term, this
    // history still produces the number that caused the incident.
    const fit = fitEnergySignature(records, NOW_MS);
    if (!fit) throw new Error('expected a fit');
    const asShipped = suggestDailyBudgetKwh({
      fit: { ...fit, recentSuppressionSuspected: false },
      forecastMeanTempC: FORECAST_MEAN_C,
    });
    expect(asShipped.suggestedBudgetKwh).toBeCloseTo(44.1, 1);
    expect(asShipped.suggestedBudgetKwh).toBeLessThan(OBSERVED_DEMAND_KWH);
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
