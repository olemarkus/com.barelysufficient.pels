import { describe, expect, it } from 'vitest';
import { resolveAdmissionPowerCeiling } from '../../lib/plan/planBudget';
import type { PowerLimitSettings } from '../../packages/contracts/src/capacitySettings';

const limits = (overrides: Partial<PowerLimitSettings> = {}): PowerLimitSettings => ({
  limitKw: 5, marginKw: 0.3, periodMinutes: 60, capacityEnabled: true, gridImportLimitKw: null, ...overrides,
});

describe('resolveAdmissionPowerCeiling', () => {
  const now = Date.UTC(2026, 10, 26, 12);

  it('sets no capacity ceiling for an hourly period, whose pace rises in an under-used hour', () => {
    expect(resolveAdmissionPowerCeiling(limits(), now)).toBeNull();
  });

  it('caps a 15-minute period at the hard cap minus the safety margin', () => {
    expect(resolveAdmissionPowerCeiling(limits({ periodMinutes: 15 }), now)).toEqual({ limit: 'capacity', kw: 4.7 });
  });

  it('uses the grid import target, and the lower limit when both bound admission', () => {
    expect(resolveAdmissionPowerCeiling(limits({ gridImportLimitKw: 8 }), now))
      .toEqual({ limit: 'grid', kw: 7.6 });
    expect(resolveAdmissionPowerCeiling(limits({ periodMinutes: 15, gridImportLimitKw: 8 }), now))
      .toEqual({ limit: 'capacity', kw: 4.7 });
    expect(resolveAdmissionPowerCeiling(limits({ periodMinutes: 15, gridImportLimitKw: 4 }), now))
      .toEqual({ limit: 'grid', kw: 3.8 });
  });

  it('ignores a capacity limit that is off and a monthly choice outside its window', () => {
    expect(resolveAdmissionPowerCeiling(limits({ periodMinutes: 15, capacityEnabled: false }), now)).toBeNull();
    const choice = { startsAtMs: now - 1000, endsAtMs: now + 1000, limitKw: 8 };
    expect(resolveAdmissionPowerCeiling(limits({ periodMinutes: 15, monthlyCapacityChoice: choice }), now))
      .toEqual({ limit: 'capacity', kw: 7.7 });
    expect(resolveAdmissionPowerCeiling(limits({ periodMinutes: 15, monthlyCapacityChoice: choice }), now + 2000))
      .toEqual({ limit: 'capacity', kw: 4.7 });
  });
});
