import type { WeatherDailyRecord } from '../../packages/contracts/src/weatherAdvisorTypes';
import {
  dayWasBudgetSuppressed,
  foldBudgetPressureDay,
  measuredBudgetOvershootKwh,
  resolveBudgetPressureKwh,
} from '../../packages/shared-domain/src/energySignature/budgetPressure';

const HOUR_MS = 60 * 60 * 1000;

const day = (overrides: Partial<WeatherDailyRecord> & { dateKey: string }): WeatherDailyRecord => ({
  kwhTotal: 40,
  tempMeanC: 5,
  tempMinC: 2,
  tempMaxC: 8,
  tempSampleCount: 24,
  quality: {
    partialTemp: false, missingKwh: false, unreliablePower: false, backfilled: false,
  },
  ...overrides,
});

/** Budget-suppressed AND over budget — the only shape that grows the term. */
const pressureDay = (dateKey: string, kwhTotal: number, appliedBudgetKwh: number): WeatherDailyRecord => day({
  dateKey,
  kwhTotal,
  appliedBudgetKwh,
  suppression: { blockedByHeadroomMs: 6 * HOUR_MS },
});

describe('dayWasBudgetSuppressed', () => {
  it('reads either censoring total the diagnostics layer already records', () => {
    expect(dayWasBudgetSuppressed(day({ dateKey: 'd', suppression: { blockedByHeadroomMs: 6 * HOUR_MS } })))
      .toBe(true);
    expect(dayWasBudgetSuppressed(day({ dateKey: 'd', suppression: { targetDeficitMs: 6 * HOUR_MS } })))
      .toBe(true);
    expect(dayWasBudgetSuppressed(day({ dateKey: 'd' }))).toBe(false);
  });

  it('pins the one-hour bar exactly — unchanged from the shipped raise-lean', () => {
    // This change moves WHEN the correction may fire, not what counts as
    // evidence. A drifting bar here would silently re-tune the shipped signal.
    const at = (ms: number) => dayWasBudgetSuppressed(day({
      dateKey: 'd', suppression: { blockedByHeadroomMs: ms },
    }));
    expect(at(60 * 60 * 1000)).toBe(true);
    expect(at(60 * 60 * 1000 - 1)).toBe(false);
  });
});

describe('measuredBudgetOvershootKwh', () => {
  it('measures how far the day ran past its budget', () => {
    expect(measuredBudgetOvershootKwh(day({ dateKey: 'd', kwhTotal: 50, appliedBudgetKwh: 44 }))).toBe(6);
    expect(measuredBudgetOvershootKwh(day({ dateKey: 'd', kwhTotal: 40, appliedBudgetKwh: 44 }))).toBe(0);
  });

  it('is undefined when either side is missing, rather than guessing a zero', () => {
    expect(measuredBudgetOvershootKwh(day({ dateKey: 'd', kwhTotal: 50 }))).toBeUndefined();
    expect(measuredBudgetOvershootKwh(day({ dateKey: 'd', kwhTotal: undefined, appliedBudgetKwh: 44 })))
      .toBeUndefined();
  });
});

describe('foldBudgetPressureDay', () => {
  it('grows by the measured overshoot on a day the budget both limited and ran out', () => {
    const first = foldBudgetPressureDay(undefined, pressureDay('2026-07-30', 51.6, 43.7));
    expect(first.kwh).toBeCloseTo(7.9, 5);
    expect(first.throughDateKey).toBe('2026-07-30');
    const second = foldBudgetPressureDay(first, pressureDay('2026-07-31', 50, 44));
    expect(second.kwh).toBeCloseTo(13.9, 5);
  });

  it('caps a single day so the loop ramps rather than jumping', () => {
    const folded = foldBudgetPressureDay(undefined, pressureDay('2026-07-30', 200, 40));
    expect(folded.kwh).toBe(10);
  });

  it('leaks on a day that stayed inside its budget, even if devices were still held back', () => {
    // The windup guard. Short holds are routine (shed cooldowns, price shaping),
    // so suppression alone must not ratchet the budget up forever — a day that
    // never ran out of budget is a shaping problem, not a level problem.
    const carried = { kwh: 8, throughDateKey: '2026-07-30' };
    const folded = foldBudgetPressureDay(carried, day({
      dateKey: '2026-07-31',
      kwhTotal: 40,
      appliedBudgetKwh: 50,
      suppression: { blockedByHeadroomMs: 12 * HOUR_MS },
    }));
    expect(folded.kwh).toBeCloseTo(6, 5);
  });

  it('HOLDS rather than decaying when the day is unmeasurable', () => {
    // A boot catch-up stamps no budget rather than a stale one, and a tracker
    // gap leaves no kWh total. Neither is evidence, so a badly-timed restart
    // must not quietly erode real evidence that the budget is too tight.
    const carried = { kwh: 8, throughDateKey: '2026-07-30' };
    const noBudget = foldBudgetPressureDay(carried, day({
      dateKey: '2026-07-31', kwhTotal: 50, suppression: { blockedByHeadroomMs: 12 * HOUR_MS },
    }));
    expect(noBudget).toEqual({ kwh: 8, throughDateKey: '2026-07-31' });
  });

  it('refuses a day the power tracker flagged unreliable', () => {
    // The fit already distrusts it, and this term writes a setting — the stuck
    // meter case must not grow the budget through a gap the model rejects.
    const folded = foldBudgetPressureDay({ kwh: 8, throughDateKey: '2026-07-30' }, day({
      dateKey: '2026-07-31',
      kwhTotal: 200,
      appliedBudgetKwh: 44,
      quality: {
        partialTemp: false, missingKwh: false, unreliablePower: true, backfilled: false,
      },
      suppression: { blockedByHeadroomMs: 12 * HOUR_MS },
    }));
    expect(folded.kwh).toBe(8);
  });

  it('will not integrate past what the suggestion could apply (anti-windup)', () => {
    // Without this the accumulator runs far above the reachable output, then
    // owes the owner days of decay before the correction even starts to relax.
    let state = foldBudgetPressureDay(undefined, pressureDay('2026-07-25', 60, 40), 9);
    for (let index = 6; index <= 9; index += 1) {
      state = foldBudgetPressureDay(state, pressureDay(`2026-07-2${index}`, 60, 40), 9);
    }
    expect(state.kwh).toBe(9);
  });

  it('re-clamps a carried term when the applicable ceiling drops', () => {
    const carried = { kwh: 30, throughDateKey: '2026-07-30' };
    const folded = foldBudgetPressureDay(carried, pressureDay('2026-07-31', 60, 40), 12);
    expect(folded.kwh).toBe(12);
  });

  it('decays to exactly zero rather than trailing a negligible remainder', () => {
    // Measurable days that stayed inside their budget — the only shape that leaks.
    const quietDay = (dateKey: string) => day({ dateKey, kwhTotal: 40, appliedBudgetKwh: 50 });
    let state = { kwh: 1, throughDateKey: '2026-07-30' };
    for (let index = 1; index <= 4; index += 1) {
      state = foldBudgetPressureDay(state, quietDay(`2026-08-0${index}`));
    }
    expect(state.kwh).toBeGreaterThan(0);
    state = foldBudgetPressureDay(state, quietDay('2026-08-05'));
    expect(state.kwh).toBe(0);
  });

  it('is idempotent per day so a repeat rollup or boot catch-up cannot inflate it', () => {
    const record = pressureDay('2026-07-31', 50, 44);
    const once = foldBudgetPressureDay(undefined, record);
    expect(foldBudgetPressureDay(once, record)).toBe(once);
    // An older day arriving late (backfill, catch-up) is ignored too.
    expect(foldBudgetPressureDay(once, pressureDay('2026-07-30', 60, 40))).toBe(once);
  });

  it('does not grow when the overshoot cannot be measured', () => {
    // A boot catch-up deliberately stamps no budget on an older day rather than
    // a stale one; with nothing to measure the term must not invent a step.
    const folded = foldBudgetPressureDay(undefined, day({
      dateKey: '2026-07-31',
      kwhTotal: 50,
      suppression: { blockedByHeadroomMs: 12 * HOUR_MS },
    }));
    expect(folded.kwh).toBe(0);
  });

  it('caps the accumulator at an absolute backstop when no ceiling is known', () => {
    let state;
    for (let index = 1; index <= 9; index += 1) {
      state = foldBudgetPressureDay(state, pressureDay(`2026-07-0${index}`, 200, 40));
    }
    expect(state?.kwh).toBe(40);
  });
});

describe('resolveBudgetPressureKwh', () => {
  it('bounds the term by a fraction of the prediction', () => {
    expect(resolveBudgetPressureKwh({
      state: { kwh: 7, throughDateKey: 'd' }, predictedKwh: 40, ceilingFraction: 0.5,
    })).toBe(7);
    expect(resolveBudgetPressureKwh({
      state: { kwh: 90, throughDateKey: 'd' }, predictedKwh: 40, ceilingFraction: 0.5,
    })).toBe(20);
  });

  it('contributes nothing without a term or a usable prediction', () => {
    expect(resolveBudgetPressureKwh({ state: undefined, predictedKwh: 40, ceilingFraction: 0.5 })).toBe(0);
    expect(resolveBudgetPressureKwh({
      state: { kwh: 7, throughDateKey: 'd' }, predictedKwh: 0, ceilingFraction: 0.5,
    })).toBe(0);
    expect(resolveBudgetPressureKwh({
      state: { kwh: Number.NaN, throughDateKey: 'd' }, predictedKwh: 40, ceilingFraction: 0.5,
    })).toBe(0);
  });
});

