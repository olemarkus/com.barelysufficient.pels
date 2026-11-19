import type { CombinedPriceFields } from '../../lib/price/priceTypes';
import type { PowerLimitSettings } from '../../packages/contracts/src/capacitySettings';
import { capacityLimitKwAt, planningPowerCeiling } from '../../packages/shared-domain/src/settings/powerLimits';
import { resolvePlanningCeilingKw } from '../../lib/power/capacityModel';
import { applyBudgetPrices } from '../../lib/price/budgetPrice';

const settings: PowerLimitSettings = {
  limitKw: 5, marginKw: 0.2, periodMinutes: 60, capacityEnabled: true, gridImportLimitKw: null,
  monthlyCapacityChoice: { startsAtMs: Date.parse('2026-10-31T23:00:00Z'), endsAtMs: Date.parse('2026-11-30T23:00:00Z'), limitKw: 9.9 },
};
const novemberEnd = Date.parse('2026-11-30T22:00:00Z');
const decemberStart = Date.parse('2026-11-30T23:00:00Z');

describe('monthly capacity forward limits', () => {
  it('expires at Oslo month rollover even while both intervals are in the same UTC date', () => {
    expect(capacityLimitKwAt(settings, novemberEnd)).toBe(9.9);
    expect(capacityLimitKwAt(settings, decemberStart)).toBe(5);
    expect(resolvePlanningCeilingKw(settings, novemberEnd)).toBeCloseTo(9.7);
    expect(resolvePlanningCeilingKw(settings, decemberStart)).toBeCloseTo(4.8);
    expect(settings.limitKw).toBe(5);
  });

  it('retains grid-import precedence and disabled capacity behaviour', () => {
    expect(planningPowerCeiling({ ...settings, gridImportLimitKw: 6 }, novemberEnd)?.kw).toBeCloseTo(5.7);
    expect(planningPowerCeiling({ ...settings, capacityEnabled: false }, novemberEnd)).toBeNull();
  });

  it('resolves price blending appetite for each period across month end', () => {
    const entries: CombinedPriceFields[] = [novemberEnd, decemberStart].map((atMs) => ({
      startsAt: new Date(atMs).toISOString(), totalPrice: 100, exportPrice: 0,
    }));
    const prices = applyBudgetPrices(entries, {
      getPowerLimitSettings: () => settings, getSurplusKwh: () => 5,
    }, 'Europe/Oslo');
    expect(prices[0]?.budgetPrice).toBeGreaterThan(prices[1]?.budgetPrice ?? Infinity);
  });
});
