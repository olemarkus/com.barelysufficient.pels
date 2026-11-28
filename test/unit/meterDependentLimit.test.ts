import { hasMeterDependentLimit } from '../../lib/power/meterDependentLimit';
import type { MainFuse, PowerLimitSettings } from '../../packages/contracts/src/capacitySettings';
import type { DailyBudgetUiPayload } from '../../packages/contracts/src/dailyBudgetTypes';

const NO_LIMITS: PowerLimitSettings = {
  limitKw: 10, marginKw: 0.2, periodMinutes: 60, capacityEnabled: false, gridImportLimitKw: null,
};
const FUSE_OFF: MainFuse = { kind: 'off' };

const budget = (enabled: boolean): DailyBudgetUiPayload => ({
  todayKey: '2026-11-28',
  days: { '2026-11-28': { budget: { enabled } } },
} as unknown as DailyBudgetUiPayload);

describe('hasMeterDependentLimit', () => {
  it('is false with Capacity limit, Grid import limit, main fuse protection and daily budget all off', () => {
    expect(hasMeterDependentLimit(NO_LIMITS, FUSE_OFF, null)).toBe(false);
    expect(hasMeterDependentLimit(NO_LIMITS, FUSE_OFF, budget(false))).toBe(false);
  });

  it('is true when any one of them is on', () => {
    expect(hasMeterDependentLimit({ ...NO_LIMITS, capacityEnabled: true }, FUSE_OFF, null)).toBe(true);
    expect(hasMeterDependentLimit({ ...NO_LIMITS, gridImportLimitKw: 9.2 }, FUSE_OFF, null)).toBe(true);
    expect(hasMeterDependentLimit(
      NO_LIMITS, { kind: 'on', supply: 'three_phase_neutral', amps: 25 }, null,
    )).toBe(true);
    expect(hasMeterDependentLimit(NO_LIMITS, FUSE_OFF, budget(true))).toBe(true);
  });
});
