import type { WeatherDailyRecord } from '../../packages/contracts/src/weatherAdvisorTypes';
import {
  dayWasBudgetDamaged, foldBudgetPressureDay,
  resolveBudgetPressureKwh, unresolvedBudgetShortfallKwh,
} from '../../packages/shared-domain/src/energySignature/budgetPressure';

const day = (over: Partial<WeatherDailyRecord> = {}): WeatherDailyRecord => ({
  dateKey: '2026-10-02', tempMeanC: 10, tempMinC: 8, tempMaxC: 12, tempSampleCount: 24,
  kwhTotal: 50, kwhBudgetCounted: 50, appliedBudgetKwh: 60,
  quality: { partialTemp: false, missingKwh: false, unreliablePower: false, backfilled: false },
  ...over,
});
const carried = { algorithmVersion: 3 as const, kwh: 20, throughDateKey: '2026-10-01' };

describe('budget demand feedback', () => {
  it('does not turn historical temporary/capacity holds into damaged days', () => {
    const record = day({ suppression: {
      budgetDenialObserved: true, budgetDeniedKwh: 30, targetDeficitMs: 12 * 3600000,
      blockedByHeadroomMs: 12 * 3600000,
    } });
    expect(dayWasBudgetDamaged(record)).toBe(false);
    expect(foldBudgetPressureDay(undefined, record).kwh).toBe(0);
  });
  it('credits unused allowance before growing on unresolved heater demand', () => {
    expect(unresolvedBudgetShortfallKwh(day({ suppression: { budgetUnservedKwh: 8 } }))).toBe(0);
    expect(unresolvedBudgetShortfallKwh(day({ suppression: { budgetUnservedKwh: 13 } }))).toBe(3);
    expect(foldBudgetPressureDay(undefined, day({ suppression: { budgetUnservedKwh: 13 } })).kwh).toBe(3);
  });
  it('recovered holds do not indicate damage, but actual overshoot corrects the allowance', () => {
    const recovered = day({
      kwhTotal: 65, kwhBudgetCounted: 65, suppression: { budgetDeniedKwh: 20, budgetUnservedKwh: 0 },
    });
    expect(dayWasBudgetDamaged(recovered)).toBe(false);
    expect(foldBudgetPressureDay(carried, recovered).kwh).toBe(25);
  });
  it('keeps a finalized, priced budget-exhausted task miss as evidence at its deadline', () => {
    const missed = day({ suppression: { deadlineMissDeniedKwh: 4, budgetUnservedKwh: 0 } });
    expect(dayWasBudgetDamaged(missed)).toBe(true);
    expect(foldBudgetPressureDay(undefined, missed).kwh).toBe(4);
  });
  it('does not double count heater and smart-task denial', () => {
    expect(unresolvedBudgetShortfallKwh(day({ kwhTotal: 65, kwhBudgetCounted: 65,
      suppression: { budgetUnservedKwh: 3, deadlineMissDeniedKwh: 4 },
    }))).toBe(9);
  });
  it('does not price an unmeasured task miss', () => {
    expect(dayWasBudgetDamaged(day({ suppression: { deadlineMissedToBudget: true } }))).toBe(false);
  });
  it('does not let negligible pressure prevent decay or widen headroom', () => {
    const record = day({ suppression: { deadlineMissDeniedKwh: 0.1 } });
    expect(dayWasBudgetDamaged(record)).toBe(false);
    expect(foldBudgetPressureDay(carried, record).kwh).toBe(5);
  });
  it('adds no more than 10 kWh per day', () => {
    expect(foldBudgetPressureDay(undefined, day({ suppression: { budgetUnservedKwh: 100 } })).kwh).toBe(10);
  });
  it('unwinds stale correction using observed spare allowance', () => {
    expect(foldBudgetPressureDay(carried, day()).kwh).toBe(5);
    expect(foldBudgetPressureDay({ ...carried, kwh: 17.8 }, day({ appliedBudgetKwh: 112.8 })).kwh)
      .toBeCloseTo(3.35);
  });
  it('decays without using unreliable or missing readings as spare allowance', () => {
    for (const quality of [
      { ...day().quality, unreliablePower: true }, { ...day().quality, missingKwh: true },
    ]) {
      const record = day({ quality, suppression: { budgetUnservedKwh: 100 } });
      expect(dayWasBudgetDamaged(record)).toBe(false);
      expect(foldBudgetPressureDay(carried, record).kwh).toBe(15);
    }
    expect(foldBudgetPressureDay(carried, day({ appliedBudgetKwh: undefined })).kwh).toBe(15);
  });
  it('still respects priced deadline evidence when the household meter was unavailable', () => {
    const record = day({ quality: { ...day().quality, unreliablePower: true },
      suppression: { deadlineMissDeniedKwh: 4 },
    });
    expect(foldBudgetPressureDay(undefined, record).kwh).toBe(4);
  });
  it('caps correction at sustainable capacity', () => {
    expect(foldBudgetPressureDay(carried, day({ suppression: { deadlineMissDeniedKwh: 8 } }), 24).kwh).toBe(24);
  });
  it('is idempotent and ignores older days', () => {
    const once = foldBudgetPressureDay(carried, day());
    expect(foldBudgetPressureDay(once, day())).toBe(once);
    expect(foldBudgetPressureDay(once, day({ dateKey: '2026-09-30' }))).toBe(once);
  });
  it('snaps negligible corrections to zero', () => {
    expect(foldBudgetPressureDay({ ...carried, kwh: 0.3 }, day({ appliedBudgetKwh: undefined })).kwh).toBe(0);
  });
  it('measures overshoot on the budget axis, not whole-home usage that includes exempt load', () => {
    // 70 kWh metered, 15 of it from a budget-exempt device: the budget counted
    // 55 against its 60, so the day ran 5 under, not 10 over.
    const exemptDay = day({ kwhTotal: 70, kwhBudgetCounted: 55 });
    expect(dayWasBudgetDamaged(exemptDay)).toBe(false);
    // Quiet day: decays by 0.75 and credits the 5 kWh of real spare allowance.
    expect(foldBudgetPressureDay(carried, exemptDay).kwh).toBe(10);
  });
  it('still grows on a real overshoot of budget-counted usage beside exempt load', () => {
    const over = day({ kwhTotal: 80, kwhBudgetCounted: 64 });
    expect(foldBudgetPressureDay(carried, over).kwh).toBe(24);
  });
  it('measures no balance on a record that predates budget-counted usage', () => {
    // Absent is not zero, and whole-home kWh cannot stand in: no overshoot, no
    // spare-allowance credit, and heater denial cannot be resolved into a shortfall.
    const legacy = day({ kwhTotal: 75, kwhBudgetCounted: undefined, suppression: { budgetUnservedKwh: 8 } });
    expect(unresolvedBudgetShortfallKwh(legacy)).toBe(0);
    expect(foldBudgetPressureDay(carried, legacy).kwh).toBe(15);
    // A priced task miss is independent evidence and still counts.
    const legacyMiss = day({ kwhBudgetCounted: undefined, suppression: { deadlineMissDeniedKwh: 4 } });
    expect(unresolvedBudgetShortfallKwh(legacyMiss)).toBe(4);
  });
  it('returns a finite positive pressure contribution', () => {
    expect(resolveBudgetPressureKwh({ state: carried })).toBe(20);
    expect(resolveBudgetPressureKwh({ state: undefined })).toBe(0);
    expect(resolveBudgetPressureKwh({ state: { ...carried, kwh: NaN } })).toBe(0);
  });
});
