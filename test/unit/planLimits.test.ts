import { describe, expect, it } from 'vitest';
import { buildPlanLimits } from '../../lib/plan/planContext';
import type { PowerLimitSettings } from '../../packages/contracts/src/capacitySettings';

const settings: PowerLimitSettings = {
  capacityEnabled: true, limitKw: 10, marginKw: 0.2, periodMinutes: 60, gridImportLimitKw: null,
};

describe('resolved planning limits', () => {
  it('keeps an unconstrained home free of invented ceilings', () => {
    expect(buildPlanLimits({ ...settings, capacityEnabled: false }, null, null)).toEqual({
      capacity: { kind: 'off' }, grid: { kind: 'off' }, daily: { kind: 'off' }, binding: { kind: 'none' },
    });
  });

  it('rebases the daily pace onto import with projected exempt demand', () => {
    const limits = buildPlanLimits(settings, 5, { budgetPaceKw: 2, projectedExemptKw: 4 });
    expect(limits.daily).toEqual({ kind: 'on', budgetPaceKw: 2, projectedExemptKw: 4 });
    expect(limits.binding).toEqual({ kind: 'bound', source: 'capacity', kw: 5 });
    expect(buildPlanLimits(settings, 8, { budgetPaceKw: 2, projectedExemptKw: 4 }).binding)
      .toEqual({ kind: 'bound', source: 'daily', kw: 6 });
  });

  it('uses the grid working target and gives it an exact tie', () => {
    const limits = buildPlanLimits({ ...settings, gridImportLimitKw: 10 }, 9.5,
      { budgetPaceKw: 9.5, projectedExemptKw: 0 });
    expect(limits.grid).toEqual({ kind: 'on', limitKw: 10, targetKw: 9.5 });
    expect(limits.binding).toEqual({ kind: 'bound', source: 'grid', kw: 9.5 });
  });

  it('preserves capacity attribution in a near tie without raising the binding pace', () => {
    expect(buildPlanLimits(settings, 5, { budgetPaceKw: 4.9995, projectedExemptKw: 0 }).binding)
      .toEqual({ kind: 'bound', source: 'capacity', kw: 4.9995 });
  });

  it('retains a zero daily pace as an enabled limit', () => {
    expect(buildPlanLimits({ ...settings, capacityEnabled: false }, null,
      { budgetPaceKw: 0, projectedExemptKw: 0 }).binding)
      .toEqual({ kind: 'bound', source: 'daily', kw: 0 });
  });
});
