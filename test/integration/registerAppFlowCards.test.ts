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
import type { Mock } from 'vitest';

describe('registerAppFlowCards', () => {
  beforeEach(() => {
    registerFlowCards.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const buildContext = (params: {
    powerSource?: string;
    powerSourceKeyPresent?: boolean;
    now?: Date;
    recordPowerSample?: AppContext['recordPowerSample'];
    requestFlowPlanRebuild?: AppContext['requestFlowPlanRebuild'];
    timers?: TimerRegistry;
    powerTracker?: PowerTrackerState;
  } = {}): AppContext => {
    const now = params.now ?? new Date('2026-04-16T00:00:00.000Z');
    const powerSourceKeyPresent = (
      params.powerSourceKeyPresent ?? params.powerSource !== undefined
    );
    return {
      homey: {
        flow: {
          getTriggerCard: vi.fn(),
          getConditionCard: vi.fn(),
          getActionCard: vi.fn(),
        },
        settings: {
          get: vi.fn((key: string) => (key === 'power_source' ? params.powerSource : undefined)),
          getKeys: vi.fn(() => (powerSourceKeyPresent ? ['power_source'] : ['another_setting'])),
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

  it('threads a provisional Main fence into the device-scoped Flow write as retryable unavailable', () => {
    const ctx = buildContext({ powerSource: 'homey_energy' });
    ctx.homeMembership = {
      getHomeIdForDevice: () => 'main',
      isOwnershipReady: () => false,
      hasPendingOwnershipGeneration: () => false,
      isMainHomeActuationFenced: () => true,
      getConfiguredMeterSources: () => ({ state: 'resolved', deviceIds: new Set() }),
    } as unknown as AppContext['homeMembership'];
    ctx.deferredObjectiveActivePlanRecorder = {} as AppContext['deferredObjectiveActivePlanRecorder'];
    ctx.deferredObjectivePlanHistoryRecorder = {} as AppContext['deferredObjectivePlanHistoryRecorder'];

    registerAppFlowCards(ctx);
    const deps = registerFlowCards.mock.calls[0]?.[0] as {
      upsertDeferredObjectiveForDevice: (params: {
        deviceId: string;
        deviceName: string | null;
        entry: {
          enabled: true;
          kind: 'temperature';
          enforcement: 'soft';
          targetTemperatureC: number;
          deadlineAtMs: number;
        };
      }) => unknown;
    };
    const outcome = deps.upsertDeferredObjectiveForDevice({
      deviceId: 'heater-main',
      deviceName: 'Hall heater',
      entry: {
        enabled: true,
        kind: 'temperature',
        enforcement: 'soft',
        targetTemperatureC: 60,
        deadlineAtMs: Date.now() + 60 * 60 * 1000,
      },
    });

    expect(outcome).toEqual({ persisted: false, reason: 'ownership_unavailable' });
    expect(ctx.homey.settings.set).not.toHaveBeenCalled();
    expect(ctx.requestFlowPlanRebuild).not.toHaveBeenCalled();
  });

  it('separates durable smart-task membership from transient Main authority', () => {
    const ctx = buildContext({ powerSource: 'homey_energy' });
    ctx.homeMembership = {
      getHomeIdForDevice: () => 'main',
      isOwnershipReady: () => true,
      hasPendingOwnershipGeneration: () => false,
      isMainHomeActuationFenced: () => true,
      getConfiguredMeterSources: () => ({ state: 'resolved', deviceIds: new Set() }),
    } as unknown as AppContext['homeMembership'];

    registerAppFlowCards(ctx);
    const deps = registerFlowCards.mock.calls[0]?.[0] as {
      isDeviceInMainHome: (deviceId: string) => boolean;
      hasMainHomeSmartTaskAuthority: (deviceId: string) => boolean;
    };

    expect(deps.isDeviceInMainHome('heater-main')).toBe(true);
    expect(deps.hasMainHomeSmartTaskAuthority('heater-main')).toBe(false);
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

  it('abandons a Flow sample when an existing source key transiently reads undefined', async () => {
    const recordPowerSample = vi.fn(async () => undefined);
    const structuredError = vi.fn();
    const ctx = buildContext({
      powerSource: undefined,
      powerSourceKeyPresent: true,
      recordPowerSample,
    });
    (ctx.getStructuredLogger as Mock).mockReturnValue({
      error: structuredError,
    });

    registerAppFlowCards(ctx);
    const deps = registerFlowCards.mock.calls[0]?.[0] as {
      recordPowerSample: (powerW: number) => Promise<void>;
    };

    await expect(deps.recordPowerSample(1234)).rejects.toThrow(
      'power source settings read is suspect',
    );
    expect(recordPowerSample).not.toHaveBeenCalled();
    expect(ctx.homey.settings.set).not.toHaveBeenCalled();
    expect(structuredError).toHaveBeenCalledWith(expect.objectContaining({
      event: 'flow_power_sample_source_read_failed',
      reason: 'missing_existing_key',
    }));
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
