import type { WeatherDailyRecord } from '../../packages/contracts/src/weatherAdvisorTypes';
import {
  dayWasBudgetDamaged,
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

describe('dayWasBudgetDamaged — day-close verdict', () => {
  it('is damaged only when energy was still denied at day close', () => {
    expect(dayWasBudgetDamaged(day({ dateKey: 'd', suppression: { budgetDeniedKwh: 1.2 } }))).toBe(true);
    expect(dayWasBudgetDamaged(day({ dateKey: 'd', suppression: { budgetDeniedKwh: 0.001 } }))).toBe(true);
  });

  // The whole point of recording an explicit zero: a day watched to its close
  // that denied nothing is NOT the same as a day with no verdict, and must not
  // fall through to counters that count served deferrals as evidence.
  it('takes a recorded zero as authoritative, never falling back to the legacy counters', () => {
    expect(dayWasBudgetDamaged(day({
      dateKey: 'd',
      suppression: { budgetDeniedKwh: 0, targetDeficitMs: 6 * HOUR_MS, blockedByHeadroomMs: 6 * HOUR_MS },
    }))).toBe(false);
  });

  // Post-verdict builds mark unwitnessed days explicitly; the legacy counters
  // count served deferrals, so they must never answer for a modern day whose
  // close simply was not witnessed.
  it('never lets an unwitnessed modern day fall back to the legacy counters', () => {
    expect(dayWasBudgetDamaged(day({
      dateKey: 'd',
      suppression: { budgetDeniedUnwitnessed: true, targetDeficitMs: 6 * HOUR_MS, blockedByHeadroomMs: 6 * HOUR_MS },
    }))).toBe(false);
  });

  it('ignores a junk verdict rather than treating it as evidence', () => {
    expect(dayWasBudgetDamaged(day({
      dateKey: 'd',
      suppression: { budgetDeniedKwh: Number.NaN, targetDeficitMs: 6 * HOUR_MS },
    }))).toBe(true);
  });
});

describe('dayWasBudgetDamaged — legacy records (no verdict)', () => {
  it('reads either censoring total the diagnostics layer already records', () => {
    expect(dayWasBudgetDamaged(day({ dateKey: 'd', suppression: { blockedByHeadroomMs: 6 * HOUR_MS } })))
      .toBe(true);
    expect(dayWasBudgetDamaged(day({ dateKey: 'd', suppression: { targetDeficitMs: 6 * HOUR_MS } })))
      .toBe(true);
    expect(dayWasBudgetDamaged(day({ dateKey: 'd' }))).toBe(false);
  });

  it('pins the one-hour bar exactly for records that predate the verdict', () => {
    // Old records keep the meaning they were written with. A drifting bar here
    // would silently re-tune what those days already said.
    const at = (ms: number) => dayWasBudgetDamaged(day({
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


describe('foldBudgetPressureDay — day-close verdict', () => {
  /** A day that ended with energy still denied, and measurably over budget. */
  const damagedDay = (dateKey: string, deniedKwh: number, kwhTotal: number, budget: number) => day({
    dateKey,
    kwhTotal,
    appliedBudgetKwh: budget,
    suppression: { budgetDeniedKwh: deniedKwh, budgetDeniedMs: 2 * HOUR_MS },
  });

  it('grows by denied energy plus the measured overshoot', () => {
    const folded = foldBudgetPressureDay(undefined, damagedDay('2026-08-08', 3, 62.83, 60.72));
    expect(folded.kwh).toBeCloseTo(3 + 2.11, 5);
  });

  it('grows by the denied energy alone on a day that never overshot — the day the old step could not see', () => {
    // The budget held everything in check AND denied a device: no overshoot
    // occurs precisely because the denial worked. The old overshoot-only step
    // read this as "nothing to correct" forever.
    const folded = foldBudgetPressureDay(undefined, damagedDay('2026-08-08', 4, 50, 60));
    expect(folded.kwh).toBeCloseTo(4, 5);
  });

  it('grows by the denial even when the meter made the overshoot unmeasurable', () => {
    // The denied side comes from diagnostics, not the meter — an unreliable
    // power day still proved its denial.
    const folded = foldBudgetPressureDay(undefined, day({
      dateKey: '2026-08-08',
      kwhTotal: 62,
      appliedBudgetKwh: 60,
      quality: {
        partialTemp: false, missingKwh: false, unreliablePower: true, backfilled: false,
      },
      suppression: { budgetDeniedKwh: 2.5 },
    }));
    expect(folded.kwh).toBeCloseTo(2.5, 5);
  });

  it('DECAYS through an overshoot when nothing was denied at day close — served holds are not damage', () => {
    // The model flip: every hold was admitted before the day ended, so the
    // budget shaped the day and hurt nobody. The overshoot says the estimate ran
    // low; correcting the estimate is the fit's job, not this term's. On the old
    // code this day GREW the term.
    const carried = { kwh: 8, throughDateKey: '2026-08-07' };
    const folded = foldBudgetPressureDay(carried, day({
      dateKey: '2026-08-08',
      kwhTotal: 62.83,
      appliedBudgetKwh: 60.72,
      suppression: { budgetDeniedKwh: 0, blockedByHeadroomMs: 6 * HOUR_MS },
    }));
    expect(folded.kwh).toBeCloseTo(6, 5);
  });

  it('still caps a verdict-bearing day at the single-day step', () => {
    const folded = foldBudgetPressureDay(undefined, damagedDay('2026-08-08', 30, 100, 60));
    expect(folded.kwh).toBe(10);
  });
});
