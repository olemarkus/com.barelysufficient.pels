// Integration-tier: the forecast-surplus composition that feeds the planning price.
// Outward seams (price coordinator, daily-budget background) are faked; the real
// surplus math + timezone hour mapping run.
import { describe, expect, it } from 'vitest';
import { wireBudgetPrice } from '../../setup/appInit/wireBudgetPrice';
import type { AppContext } from '../../lib/app/appContext';
import type { BudgetPriceInputs } from '../../lib/price/budgetPrice';

const makeCtx = (params: {
  capture: (inputs: BudgetPriceInputs) => void;
  grossByHour?: Record<number, number>;
  limitKw?: number;
}): AppContext => ({
  priceCoordinator: { setBudgetPriceInputs: params.capture },
  dailyBudgetService: { getGrossBackgroundKwh: (hour: number) => params.grossByHour?.[hour] },
  capacitySettings: { limitKw: params.limitKw ?? 5, marginKw: 0 },
  getTimeZone: () => 'UTC',
} as unknown as AppContext);

const noon = Date.UTC(2026, 5, 27, 12, 0, 0);

describe('wireBudgetPrice — forecast-surplus composition', () => {
  it('injects surplus = max(0, forecast − gross background), capacity as the denominator', () => {
    let captured: BudgetPriceInputs | undefined;
    const ctx = makeCtx({ capture: (i) => { captured = i; }, grossByHour: { 12: 0.5 }, limitKw: 7 });
    wireBudgetPrice(ctx, (ms) => (ms === noon ? 3 : undefined));

    expect(captured?.expectedManagedDrawKwh).toBe(7);
    expect(captured?.getSurplusKwh(noon)).toBeCloseTo(2.5, 9); // 3 − 0.5
  });

  it('reflects a runtime capacity-limit change (live getter, not frozen at boot)', () => {
    let captured: BudgetPriceInputs | undefined;
    const ctx = makeCtx({ capture: (i) => { captured = i; }, limitKw: 5 });
    wireBudgetPrice(ctx, () => 1);
    ctx.capacitySettings.limitKw = 9;
    expect(captured?.expectedManagedDrawKwh).toBe(9);
  });

  it('reports no surplus when the forecast is unavailable', () => {
    let captured: BudgetPriceInputs | undefined;
    wireBudgetPrice(makeCtx({ capture: (i) => { captured = i; } }), () => undefined);
    expect(captured?.getSurplusKwh(noon)).toBeUndefined();
  });

  it('reports no surplus until the gross background is learned (no fabricated 0)', () => {
    let captured: BudgetPriceInputs | undefined;
    // grossByHour omitted ⇒ getGrossBackgroundKwh returns undefined for every hour
    wireBudgetPrice(makeCtx({ capture: (i) => { captured = i; } }), () => 3);
    expect(captured?.getSurplusKwh(noon)).toBeUndefined();
  });

  it('clamps surplus to zero when the background exceeds the forecast', () => {
    let captured: BudgetPriceInputs | undefined;
    const ctx = makeCtx({ capture: (i) => { captured = i; }, grossByHour: { 12: 5 } });
    wireBudgetPrice(ctx, () => 1); // forecast 1 < background 5
    expect(captured?.getSurplusKwh(noon)).toBe(0);
  });

  it('is a no-op (no throw) before the price coordinator exists', () => {
    const ctx = { dailyBudgetService: {}, getTimeZone: () => 'UTC', capacitySettings: { limitKw: 5 } } as unknown as AppContext;
    expect(() => wireBudgetPrice(ctx, () => 1)).not.toThrow();
  });
});
