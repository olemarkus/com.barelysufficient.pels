import { describe, expect, it } from 'vitest';
import { resolveBudgetPrice, applyBudgetPrices, resolveExpectedManagedDrawKwh } from '../../lib/price/budgetPrice';
import type { CombinedHourlyPrice } from '../../lib/price/priceTypes';
import { capacityOnlyPowerLimits, powerLimits } from '../helpers/powerLimitSettings';

describe('resolveBudgetPrice', () => {
  const base = { totalPrice: 100, exportPrice: 20, surplusKwh: 2, expectedManagedDrawKwh: 4 };

  it('falls back (undefined) without an export price', () => {
    expect(resolveBudgetPrice({ ...base, exportPrice: undefined })).toBeUndefined();
  });

  it('falls back without trusted surplus or appetite', () => {
    expect(resolveBudgetPrice({ ...base, surplusKwh: 0 })).toBeUndefined();
    expect(resolveBudgetPrice({ ...base, surplusKwh: undefined })).toBeUndefined();
    expect(resolveBudgetPrice({ ...base, expectedManagedDrawKwh: 0 })).toBeUndefined();
  });

  it('blends export and import by coverage', () => {
    // coverage = 2/4 = 0.5 ⇒ 0.5*20 + 0.5*100 = 60
    expect(resolveBudgetPrice(base)).toBeCloseTo(60, 9);
  });

  it('clamps coverage at 1 — surplus beyond appetite is fully the export price', () => {
    expect(resolveBudgetPrice({ ...base, surplusKwh: 10 })).toBeCloseTo(20, 9);
  });

  it('honours a negative export price (feed-in fee) in the blend', () => {
    // coverage 0.5 ⇒ 0.5*(-5) + 0.5*100 = 47.5
    expect(resolveBudgetPrice({ ...base, exportPrice: -5 })).toBeCloseTo(47.5, 9);
  });
});

describe('applyBudgetPrices', () => {
  const entry = (startsAt: string, totalPrice: number, exportPrice?: number): CombinedHourlyPrice => ({
    startsAt, totalPrice, ...(exportPrice === undefined ? {} : { exportPrice }),
  });

  it('is a no-op without flexible appetite', () => {
    // A non-positive appetite (a saved hard cap of 0 kW) gives the blend nothing to
    // weigh the surplus against, so the planning price stays on the import price.
    const prices = [entry('2026-06-27T10:00:00.000Z', 100, 20)];
    const out = applyBudgetPrices(prices, {
      getSurplusKwh: () => 5,
      getPowerLimitSettings: () => powerLimits({ enabled: false, limitKw: 0, marginKw: 0 }, null),
    }, 'UTC');
    expect(out).toBe(prices);
  });

  it('keeps blending surplus when no power limit is enabled', () => {
    const prices = [entry('2026-06-27T10:00:00.000Z', 100, 20)];
    const noLimits = powerLimits({ enabled: false, limitKw: 4, marginKw: 0 }, null);
    const out = applyBudgetPrices(prices, { getSurplusKwh: () => 2, getPowerLimitSettings: () => noLimits }, 'UTC');
    // coverage = 2 / 4 = 0.5 → 0.5 × 20 + 0.5 × 100
    expect(out[0].budgetPrice).toBeCloseTo(60, 9);
  });

  it('adds budgetPrice only to hours with both surplus and an export price', () => {
    const sunny = '2026-06-27T12:00:00.000Z';
    const cloudy = '2026-06-27T20:00:00.000Z';
    const noExport = '2026-06-27T13:00:00.000Z';
    const prices = [entry(sunny, 100, 20), entry(cloudy, 100, 20), entry(noExport, 100)];
    const surplus: Record<string, number> = { [Date.parse(sunny)]: 4, [Date.parse(cloudy)]: 0, [Date.parse(noExport)]: 4 };

    const out = applyBudgetPrices(prices, {
      getSurplusKwh: (ms) => surplus[ms],
      getPowerLimitSettings: () => capacityOnlyPowerLimits(4, 0.5),
    }, 'UTC');

    expect(out[0].budgetPrice).toBeCloseTo(20, 9); // full coverage at noon
    expect(out[1].budgetPrice).toBeUndefined(); // no surplus in the evening
    expect(out[2].budgetPrice).toBeUndefined(); // no export price configured
    expect(out[0].totalPrice).toBe(100); // total is never mutated
  });
});

describe('resolveExpectedManagedDrawKwh', () => {
  it('is the hard cap itself, not the hard cap minus margin, with only Capacity limit on', () => {
    // Byte-identical to the appetite every capacity-only install planned with.
    expect(resolveExpectedManagedDrawKwh(capacityOnlyPowerLimits(10, 0.2))).toBe(10);
  });

  it('keeps the saved hard cap as the appetite estimate when no power limit is enabled', () => {
    // An appetite, not a limit: without it a home with both limits off loses the
    // solar-aware planning price it had before the switches existed.
    expect(resolveExpectedManagedDrawKwh(powerLimits({ enabled: false, limitKw: 10, marginKw: 0.2 }, null)))
      .toBe(10);
  });

  it('is the grid import limit once Capacity limit is off', () => {
    expect(resolveExpectedManagedDrawKwh(powerLimits({ enabled: false, limitKw: 5, marginKw: 0.2 }, 17))).toBe(17);
  });

  it('is the lower configured limit when both are on', () => {
    expect(resolveExpectedManagedDrawKwh(powerLimits({ enabled: true, limitKw: 10, marginKw: 0.2 }, 7.4))).toBe(7.4);
    expect(resolveExpectedManagedDrawKwh(powerLimits({ enabled: true, limitKw: 5, marginKw: 0.2 }, 17))).toBe(5);
  });
});
