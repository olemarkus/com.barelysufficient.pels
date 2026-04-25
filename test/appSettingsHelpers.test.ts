import {
  buildCapacitySettingsSnapshot,
  initSettingsHandlerForApp,
  type CapacitySettingsSnapshot,
} from '../lib/app/appSettingsHelpers';
import type { AppContext } from '../lib/app/appContext';
import { TimerRegistry } from '../lib/app/timerRegistry';
import { CAPACITY_LIMIT_KW, DEVICE_DRIVER_OVERRIDES } from '../lib/utils/settingsKeys';

const buildCapacitySnapshot = (
  overrides: Partial<CapacitySettingsSnapshot> = {},
): CapacitySettingsSnapshot => ({
  capacitySettings: { limitKw: 12, marginKw: 0.5 },
  modeAliases: {},
  operatingMode: 'Home',
  capacityPriorities: {},
  modeDeviceTargets: {},
  capacityDryRun: false,
  controllableDevices: {},
  managedDevices: {},
  budgetExemptDevices: {},
  nativeEvWiringDevices: {},
  deviceDriverOverrides: {},
  deviceControlProfiles: {},
  deviceCommunicationModels: {},
  experimentalEvSupportEnabled: false,
  shedBehaviors: {},
  ...overrides,
});

const buildContext = (): AppContext => {
  const settingsListeners = new Map<string, (...args: unknown[]) => void>();
  const priceRefresh = vi.fn();
  const timers = new TimerRegistry();
  return {
    homey: {
      settings: {
        get: vi.fn(),
        set: vi.fn(),
        on: vi.fn((event: string, listener: (...args: unknown[]) => void) => {
          settingsListeners.set(event, listener);
        }),
        off: vi.fn((event: string, listener: (...args: unknown[]) => void) => {
          if (settingsListeners.get(event) === listener) {
            settingsListeners.delete(event);
          }
        }),
      },
    } as never,
    log: vi.fn(),
    error: vi.fn(),
    logDebug: vi.fn(),
    getStructuredLogger: vi.fn(),
    getStructuredDebugEmitter: vi.fn(),
    getNow: () => new Date('2026-04-16T00:00:00.000Z'),
    getTimeZone: () => 'Europe/Oslo',
    notifyOperatingModeChanged: vi.fn(),
    loadPowerTracker: vi.fn(),
    loadCapacitySettings: vi.fn(),
    loadPriceOptimizationSettings: vi.fn(),
    updatePriceOptimizationEnabled: vi.fn(),
    updateDebugLoggingEnabled: vi.fn(),
    updateOverheadToken: vi.fn(async () => undefined),
    registerFlowCards: vi.fn(),
    refreshTargetDevicesSnapshot: vi.fn(async () => undefined),
    recordPowerSample: vi.fn(async () => undefined),
    startHeartbeat: vi.fn(),
    handleOperatingModeChange: vi.fn(async () => undefined),
    getFlowSnapshot: vi.fn(async () => []),
    getCurrentPriceLevel: vi.fn(),
    isCurrentHourCheap: vi.fn(() => false),
    isCurrentHourExpensive: vi.fn(() => false),
    getDeviceLoadSetting: vi.fn(async () => null),
    setExpectedOverride: vi.fn(() => false),
    storeFlowPriceData: vi.fn(),
    loadDailyBudgetSettings: vi.fn(),
    updateDailyBudgetState: vi.fn(),
    disableManagedEvDevices: vi.fn(),
    requestFlowPlanRebuild: vi.fn(),
    getPriorityForDevice: vi.fn(() => 0),
    resolveModeName: vi.fn((name: string) => name),
    getAllModes: vi.fn(() => new Set<string>()),
    resolveManagedState: vi.fn(() => false),
    getCommunicationModel: vi.fn(() => 'local'),
    isCapacityControlEnabled: vi.fn(() => false),
    isBudgetExempt: vi.fn(() => false),
    getShedBehavior: vi.fn(() => ({ action: 'turn_off', temperature: null, stepId: null })),
    computeDynamicSoftLimit: vi.fn(() => 0),
    getDynamicSoftLimitOverride: vi.fn(() => null),
    evaluateHeadroomForDevice: vi.fn(() => null),
    getCombinedHourlyPrices: vi.fn(() => []),
    getDailyBudgetUiPayload: vi.fn(() => null),
    getLatestPlanSnapshotForUi: vi.fn(() => null),
    get powerTracker() { return {}; },
    set powerTracker(_value) {},
    get capacitySettings() { return { limitKw: 12, marginKw: 0.5 }; },
    set capacitySettings(_value) {},
    get capacityDryRun() { return false; },
    set capacityDryRun(_value) {},
    get operatingMode() { return 'Home'; },
    set operatingMode(_value) {},
    get modeAliases() { return {}; },
    set modeAliases(_value) {},
    get capacityPriorities() { return {}; },
    set capacityPriorities(_value) {},
    get modeDeviceTargets() { return {}; },
    set modeDeviceTargets(_value) {},
    get controllableDevices() { return {}; },
    set controllableDevices(_value) {},
    get managedDevices() { return {}; },
    set managedDevices(_value) {},
    get budgetExemptDevices() { return {}; },
    set budgetExemptDevices(_value) {},
    get deviceDriverOverrides() { return {}; },
    set deviceDriverOverrides(_value) {},
    get deviceControlProfiles() { return {}; },
    set deviceControlProfiles(_value) {},
    get deviceCommunicationModels() { return {}; },
    set deviceCommunicationModels(_value) {},
    get experimentalEvSupportEnabled() { return false; },
    set experimentalEvSupportEnabled(_value) {},
    get shedBehaviors() { return {}; },
    set shedBehaviors(_value) {},
    get debugLoggingTopics() { return new Set(); },
    set debugLoggingTopics(_value) {},
    get defaultComputeDynamicSoftLimit() { return undefined; },
    set defaultComputeDynamicSoftLimit(_value) {},
    get lastKnownPowerKw() { return {}; },
    get expectedPowerKwOverrides() { return {}; },
    get lastPositiveMeasuredPowerKw() { return {}; },
    get lastNotifiedOperatingMode() { return 'Home'; },
    set lastNotifiedOperatingMode(_value) {},
    get powerSampleRebuildState() { return { lastMs: 0, lastRebuildPowerW: 0 }; },
    set powerSampleRebuildState(_value) {},
    get latestTargetSnapshot() { return []; },
    get priceOptimizationEnabled() { return false; },
    get priceOptimizationSettings() { return {}; },
    capacityGuard: {
      setLimit: vi.fn(),
      setSoftMargin: vi.fn(),
    } as never,
    dailyBudgetService: {
      loadSettings: vi.fn(),
      updateState: vi.fn(),
      resetLearning: vi.fn(),
    } as never,
    priceCoordinator: {
      refreshGridTariffData: priceRefresh,
    } as never,
    snapshotHelpers: {} as never,
    homeyEnergyHelpers: {
      restart: vi.fn(),
    } as never,
    deviceControlHelpers: {} as never,
    planService: {
      rebuildPlanFromCache: vi.fn(async () => undefined),
    } as never,
    timers,
  };
};

describe('initSettingsHandlerForApp', () => {
  it('routes daily budget updates through the app context callback', async () => {
    const ctx = buildContext();

    const { handle } = initSettingsHandlerForApp(ctx);
    await handle(CAPACITY_LIMIT_KW);

    expect(ctx.updateDailyBudgetState).toHaveBeenCalledWith({ forcePlanRebuild: true });
    expect(ctx.dailyBudgetService?.updateState).not.toHaveBeenCalled();
  });

  it('fails fast when price coordinator wiring is missing', () => {
    const ctx = buildContext();
    delete ctx.priceCoordinator;

    expect(() => initSettingsHandlerForApp(ctx)).toThrow(
      'PriceCoordinator must be initialized before settings handler setup.',
    );
  });

  it('fails fast when plan service wiring is missing', () => {
    const ctx = buildContext();
    delete ctx.planService;

    expect(() => initSettingsHandlerForApp(ctx)).toThrow(
      'PlanService must be initialized before settings handler setup.',
    );
  });

  it('fails fast when daily budget service wiring is missing', () => {
    const ctx = buildContext();
    delete ctx.dailyBudgetService;

    expect(() => initSettingsHandlerForApp(ctx)).toThrow(
      'DailyBudgetService must be initialized before settings handler setup.',
    );
  });
});

describe('buildCapacitySettingsSnapshot', () => {
  it('loads normalized device driver overrides from settings', () => {
    const settings = {
      get: vi.fn((key: string) => (
        key === DEVICE_DRIVER_OVERRIDES
          ? {
            ' 0528ae3e-1289-49db-8fb4-624c32592745 ': ' homey:app:com.zaptec:go2 ',
            empty: '   ',
            '   ': 'homey:app:com.zaptec:go',
          }
          : undefined
      )),
    };

    const next = buildCapacitySettingsSnapshot({
      settings: settings as never,
      current: buildCapacitySnapshot({
        deviceDriverOverrides: {
          old: 'homey:app:com.zaptec:go',
        },
      }),
    });

    expect(next.deviceDriverOverrides).toEqual({
      '0528ae3e-1289-49db-8fb4-624c32592745': 'homey:app:com.zaptec:go2',
    });
  });

  it('keeps current device driver overrides when settings payload is invalid', () => {
    const settings = {
      get: vi.fn((key: string) => (
        key === DEVICE_DRIVER_OVERRIDES ? { device: 123 } : undefined
      )),
    };

    const next = buildCapacitySettingsSnapshot({
      settings: settings as never,
      current: buildCapacitySnapshot({
        deviceDriverOverrides: {
          device: 'homey:app:com.zaptec:go2',
        },
      }),
    });

    expect(next.deviceDriverOverrides).toEqual({
      device: 'homey:app:com.zaptec:go2',
    });
  });
});
