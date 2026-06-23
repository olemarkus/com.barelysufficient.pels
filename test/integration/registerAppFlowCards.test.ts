const { registerFlowCards } = vi.hoisted(() => ({
  registerFlowCards: vi.fn(),
}));

vi.mock('../../flowCards/registerFlowCards', () => ({
  registerFlowCards: registerFlowCards,
}));

import { registerAppFlowCards } from '../../setup/appInit';
import type { AppContext } from '../../lib/app/appContext';
import { TimerRegistry } from '../../lib/utils/timerRegistry';
import type { PowerTrackerState } from '../../lib/power/tracker';

describe('registerAppFlowCards', () => {
  beforeEach(() => {
    registerFlowCards.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const buildContext = (params: {
    powerSource?: string;
    now?: Date;
    recordPowerSample?: AppContext['recordPowerSample'];
    requestFlowPlanRebuild?: AppContext['requestFlowPlanRebuild'];
    timers?: TimerRegistry;
    powerTracker?: PowerTrackerState;
  } = {}): AppContext => {
    const now = params.now ?? new Date('2026-04-16T00:00:00.000Z');
    return {
      homey: {
        flow: {
          getTriggerCard: vi.fn(),
          getConditionCard: vi.fn(),
          getActionCard: vi.fn(),
        },
        settings: {
          get: vi.fn((key: string) => (key === 'power_source' ? params.powerSource : undefined)),
          set: vi.fn(),
        },
      },
      resolveModeName: vi.fn((mode: string) => mode),
      getAllModes: vi.fn(() => new Set<string>()),
      operatingMode: 'Home',
      handleOperatingModeChange: vi.fn(async () => undefined),
      getCurrentPriceLevel: vi.fn(),
      recordPowerSample: params.recordPowerSample ?? vi.fn(async () => undefined),
      getFlowSnapshot: vi.fn(async () => []),
      refreshTargetDevicesSnapshot: vi.fn(async () => undefined),
      deviceControlHelpers: { reportSteppedLoadActualStep: vi.fn() },
      getDeviceLoadSetting: vi.fn(async () => null),
      setExpectedOverride: vi.fn(() => false),
      storeFlowPriceData: vi.fn(),
      requestFlowPlanRebuild: params.requestFlowPlanRebuild ?? vi.fn(),
      evaluateHeadroomForDevice: vi.fn(() => null),
      updateDailyBudgetState: vi.fn(),
      getCombinedHourlyPrices: vi.fn(() => []),
      getTimeZone: vi.fn(() => 'Europe/Oslo'),
      getNow: vi.fn(() => now),
      getStructuredLogger: vi.fn(() => undefined),
      getStructuredDebugEmitter: vi.fn(() => vi.fn()),
      log: vi.fn(),
      error: vi.fn(),
      timers: params.timers ?? new TimerRegistry(),
      get powerTracker() { return params.powerTracker ?? {}; },
      set powerTracker(_value) {},
    } as unknown as AppContext;
  };

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
      getStructuredLogger: vi.fn(() => undefined),
      getStructuredDebugEmitter: vi.fn(() => vi.fn()),
      log: vi.fn(),
      error: vi.fn(),
      timers: new TimerRegistry(),
      powerTracker: {},
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
      getStructuredLogger: vi.fn(() => undefined),
      getStructuredDebugEmitter: vi.fn(() => vi.fn()),
      log: vi.fn(),
      error: vi.fn(),
      timers: new TimerRegistry(),
      powerTracker: {},
    } as unknown as AppContext;

    registerAppFlowCards(ctx);
    const deps = registerFlowCards.mock.calls[0]?.[0];

    await deps.updateDailyBudgetState({ forcePlanRebuild: true });

    expect(updateDailyBudgetState).toHaveBeenCalledWith({ forcePlanRebuild: true });
    expect(dailyBudgetServiceUpdateState).not.toHaveBeenCalled();
  });

  it('records Flow power with the same timestamp used to start the freshness clock', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-16T10:05:30.000Z'));
    const now = new Date('2026-04-16T10:05:30.000Z');
    const recordPowerSample = vi.fn(async () => undefined);
    const requestFlowPlanRebuild = vi.fn();
    const ctx = buildContext({
      powerSource: 'flow',
      now,
      recordPowerSample,
      requestFlowPlanRebuild,
    });

    registerAppFlowCards(ctx);
    const deps = registerFlowCards.mock.calls[0]?.[0] as {
      recordPowerSample: (powerW: number) => Promise<void>;
    };
    await deps.recordPowerSample(1234);

    expect(recordPowerSample).toHaveBeenCalledWith(1234, now.getTime());
    await vi.advanceTimersByTimeAsync(10_000);
    expect(requestFlowPlanRebuild).toHaveBeenCalledWith('flow_power_sample_hold');
  });

  it('starts the freshness clock from the persisted Flow sample timestamp during registration', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-16T10:05:30.000Z'));
    const now = new Date('2026-04-16T10:05:30.000Z');
    const recordPowerSample = vi.fn(async () => undefined);
    const requestFlowPlanRebuild = vi.fn();
    const ctx = buildContext({
      powerSource: 'flow',
      now,
      recordPowerSample,
      requestFlowPlanRebuild,
      powerTracker: { lastTimestamp: now.getTime() - 15_000 },
    });

    registerAppFlowCards(ctx);

    expect(recordPowerSample).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(requestFlowPlanRebuild).toHaveBeenCalledWith('flow_power_sample_hold');
  });

  it('ignores Flow-reported power when Homey Energy is the active power source', async () => {
    const recordPowerSample = vi.fn(async () => undefined);
    const requestFlowPlanRebuild = vi.fn();
    const ctx = buildContext({
      powerSource: 'homey_energy',
      recordPowerSample,
      requestFlowPlanRebuild,
    });

    registerAppFlowCards(ctx);
    const deps = registerFlowCards.mock.calls[0]?.[0] as {
      recordPowerSample: (powerW: number) => Promise<void>;
    };
    await deps.recordPowerSample(1234);

    expect(recordPowerSample).not.toHaveBeenCalled();
    expect(requestFlowPlanRebuild).not.toHaveBeenCalled();
  });
});
