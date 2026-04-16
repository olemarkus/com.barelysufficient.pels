const { registerFlowCards } = vi.hoisted(() => ({
  registerFlowCards: vi.fn(),
}));

vi.mock('../flowCards/registerFlowCards', () => ({
  registerFlowCards: registerFlowCards,
}));

import { registerAppFlowCards } from '../lib/app/appInit';
import type { AppContext } from '../lib/app/appContext';

describe('registerAppFlowCards', () => {
  beforeEach(() => {
    registerFlowCards.mockReset();
  });

  it('passes the validated flow homey surface through without erasing the contract', () => {
    const homey = {
      flow: {
        getTriggerCard: vi.fn(),
        getConditionCard: vi.fn(),
        getActionCard: vi.fn(),
      },
      settings: {
        get: vi.fn(),
        set: vi.fn(),
      },
    };
    const ctx = {
      homey,
      resolveModeName: vi.fn((mode: string) => mode),
      getAllModes: vi.fn(() => new Set<string>()),
      operatingMode: 'Home',
      handleOperatingModeChange: vi.fn(async () => undefined),
      getCurrentPriceLevel: vi.fn(),
      recordPowerSample: vi.fn(async () => undefined),
      getFlowSnapshot: vi.fn(async () => []),
      refreshTargetDevicesSnapshot: vi.fn(async () => undefined),
      deviceControlHelpers: { reportSteppedLoadActualStep: vi.fn() },
      getDeviceLoadSetting: vi.fn(async () => null),
      setExpectedOverride: vi.fn(() => false),
      storeFlowPriceData: vi.fn(),
      requestFlowPlanRebuild: vi.fn(),
      evaluateHeadroomForDevice: vi.fn(() => null),
      updateDailyBudgetState: vi.fn(),
      getCombinedHourlyPrices: vi.fn(() => []),
      getTimeZone: vi.fn(() => 'Europe/Oslo'),
      getNow: vi.fn(() => new Date('2026-04-16T00:00:00.000Z')),
      log: vi.fn(),
      logDebug: vi.fn(),
      error: vi.fn(),
    } as unknown as AppContext;

    registerAppFlowCards(ctx);

    expect(registerFlowCards).toHaveBeenCalledWith(expect.objectContaining({
      homey,
    }));
  });

  it('routes daily budget updates through the app context callback', async () => {
    const updateDailyBudgetState = vi.fn();
    const dailyBudgetServiceUpdateState = vi.fn();
    const ctx = {
      homey: {
        flow: {
          getTriggerCard: vi.fn(),
          getConditionCard: vi.fn(),
          getActionCard: vi.fn(),
        },
        settings: {
          get: vi.fn(),
          set: vi.fn(),
        },
      },
      resolveModeName: vi.fn((mode: string) => mode),
      getAllModes: vi.fn(() => new Set<string>()),
      operatingMode: 'Home',
      handleOperatingModeChange: vi.fn(async () => undefined),
      getCurrentPriceLevel: vi.fn(),
      recordPowerSample: vi.fn(async () => undefined),
      capacityGuard: { getHeadroom: vi.fn(() => null), setLimit: vi.fn() },
      getFlowSnapshot: vi.fn(async () => []),
      refreshTargetDevicesSnapshot: vi.fn(async () => undefined),
      deviceControlHelpers: { reportSteppedLoadActualStep: vi.fn() },
      getDeviceLoadSetting: vi.fn(async () => null),
      setExpectedOverride: vi.fn(() => false),
      storeFlowPriceData: vi.fn(),
      requestFlowPlanRebuild: vi.fn(),
      evaluateHeadroomForDevice: vi.fn(() => null),
      dailyBudgetService: {
        loadSettings: vi.fn(),
        updateState: dailyBudgetServiceUpdateState,
      },
      updateDailyBudgetState,
      getCombinedHourlyPrices: vi.fn(() => []),
      getTimeZone: vi.fn(() => 'Europe/Oslo'),
      getNow: vi.fn(() => new Date('2026-04-16T00:00:00.000Z')),
      log: vi.fn(),
      logDebug: vi.fn(),
      error: vi.fn(),
    } as unknown as AppContext;

    registerAppFlowCards(ctx);
    const deps = registerFlowCards.mock.calls[0]?.[0];

    await deps.updateDailyBudgetState({ forcePlanRebuild: true });

    expect(updateDailyBudgetState).toHaveBeenCalledWith({ forcePlanRebuild: true });
    expect(dailyBudgetServiceUpdateState).not.toHaveBeenCalled();
  });
});
