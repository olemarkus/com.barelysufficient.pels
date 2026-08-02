import {
  buildCapacitySettingsSnapshot,
  initSettingsHandlerForApp,
  isTemperatureControlDisabledForApp,
  loadTemperatureControlPolicySettingsForApp,
  type CapacitySettingsSnapshot,
} from '../../setup/appSettingsHelpers';
import type { AppContext } from '../../lib/app/appContext';
import type { ShedAction } from '../../lib/plan/planTypes';
import type { DebugLoggingTopic } from '../../packages/shared-domain/src/utils/debugLogging';
import { TimerRegistry } from '../../lib/utils/timerRegistry';
import {
  CAPACITY_DRY_RUN,
  CAPACITY_LIMIT_KW,
  CAPACITY_MARGIN_KW,
  DEVICE_DRIVER_OVERRIDES,
  DEVICE_TARGET_POWER_CONFIGS,
  POWER_SOURCE,
  POWER_TRACKER_STATE,
  TEMPERATURE_CONTROL_DISABLED_DEVICES,
} from '../../lib/utils/settingsKeys';

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
  temperatureControlDisabledDevices: {},
  temperatureControlPolicyState: 'unavailable',
  temperatureBoostSettings: {},
  evBoostSettings: {},
  nativeEvWiringDevices: {},
  deviceDriverOverrides: {},
  deviceControlProfiles: {},
  deviceTargetPowerConfigs: {},
  deviceCommunicationModels: {},
  shedBehaviors: {},
  ...overrides,
});

const buildContext = (): AppContext => {
  const settingsListeners = new Map<string, (...args: unknown[]) => void>();
  const priceRefresh = vi.fn();
  const timers = new TimerRegistry();
  // Deliberate partial of the broad AppContext surface — this suite exercises the
  // settings-handler wiring, not the full context, so the unrelated flow-backed
  // capability methods are intentionally absent.
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
    loadTemperatureControlPolicySettings: vi.fn(),
    loadPriceOptimizationSettings: vi.fn(),
    updatePriceOptimizationEnabled: vi.fn(),
    updateDebugLoggingEnabled: vi.fn(),
    updateOverheadToken: vi.fn(async () => undefined),
    registerFlowCards: vi.fn(),
    refreshTargetDevicesSnapshot: vi.fn(async () => undefined),
    recordPowerSample: vi.fn(async () => ({ state: 'admitted' as const, revision: 1 })),
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
    requestFlowPlanRebuild: vi.fn(),
    getPriorityForDevice: vi.fn(() => 0),
    resolveModeName: vi.fn((name: string) => name),
    getAllModes: vi.fn(() => new Set<string>()),
    resolveManagedState: vi.fn(() => false),
    getCommunicationModel: vi.fn((): 'local' | 'cloud' => 'local'),
    isCapacityControlEnabled: vi.fn(() => false),
    isBudgetExempt: vi.fn(() => false),
    getTemperatureBoostConfig: vi.fn(() => undefined),
    getEvBoostConfig: vi.fn(() => undefined),
    getShedBehavior: vi.fn(() => ({ action: 'turn_off' as ShedAction, temperature: null, stepId: null })),
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
    get temperatureControlDisabledDevices() { return {}; },
    set temperatureControlDisabledDevices(_value) {},
    get temperatureControlPolicyState() { return 'resolved' as const; },
    set temperatureControlPolicyState(_value) {},
    get temperatureBoostSettings() { return {}; },
    set temperatureBoostSettings(_value) {},
    get evBoostSettings() { return {}; },
    set evBoostSettings(_value) {},
    get deviceDriverOverrides() { return {}; },
    set deviceDriverOverrides(_value) {},
    get deviceControlProfiles() { return {}; },
    set deviceControlProfiles(_value) {},
    get deviceTargetPowerConfigs() { return {}; },
    set deviceTargetPowerConfigs(_value) {},
    get deviceCommunicationModels() { return {}; },
    set deviceCommunicationModels(_value) {},
    get shedBehaviors() { return {}; },
    set shedBehaviors(_value) {},
    get debugLoggingTopics() { return new Set<DebugLoggingTopic>(); },
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
  } as unknown as AppContext;
};

describe('initSettingsHandlerForApp', () => {
  it('publishes the temperature-control policy at the synchronous settings edge', async () => {
    const ctx = buildContext();
    const { handle } = initSettingsHandlerForApp(ctx);

    const handling = handle(TEMPERATURE_CONTROL_DISABLED_DEVICES);

    expect(ctx.loadTemperatureControlPolicySettings).toHaveBeenCalledTimes(1);
    await handling;
  });

  it('routes daily budget updates through the app context callback', async () => {
    const ctx = buildContext();

    const { handle } = initSettingsHandlerForApp(ctx);
    await handle(CAPACITY_LIMIT_KW);

    expect(ctx.updateDailyBudgetState).toHaveBeenCalledWith({
      forcePlanRebuild: true,
      persistReason: 'manual',
    });
    expect(ctx.dailyBudgetService?.updateState).not.toHaveBeenCalled();
  });

  it('routes home-suffixed writes to the hook instead of the main handlers', async () => {
    const ctx = buildContext();
    const onHomeScopedSettingChanged = vi.fn();

    const { handle } = initSettingsHandlerForApp(ctx, { onHomeScopedSettingChanged });
    await handle(`${POWER_TRACKER_STATE}:cabin`);
    await handle(`${CAPACITY_LIMIT_KW}:cabin`);

    expect(onHomeScopedSettingChanged).toHaveBeenCalledTimes(2);
    expect(onHomeScopedSettingChanged).toHaveBeenNthCalledWith(1, POWER_TRACKER_STATE, 'cabin');
    expect(onHomeScopedSettingChanged).toHaveBeenNthCalledWith(2, CAPACITY_LIMIT_KW, 'cabin');
    // The critical invariant: a suffixed write must not run the main home's
    // handler for the base key (reload main's tracker / capacity settings).
    expect(ctx.loadPowerTracker).not.toHaveBeenCalled();
    expect(ctx.loadCapacitySettings).not.toHaveBeenCalled();
    expect(ctx.updateDailyBudgetState).not.toHaveBeenCalled();
  });

  it('routes a global source change through the home-runtime epoch hook', async () => {
    const ctx = buildContext();
    const onHomeRuntimePowerSourceChanged = vi.fn();
    const { handle } = initSettingsHandlerForApp(ctx, {
      onHomeRuntimePowerSourceChanged,
    });

    await handle(POWER_SOURCE);

    expect(onHomeRuntimePowerSourceChanged).toHaveBeenCalledTimes(1);
  });

  it('dispatches unsuffixed keys to the main handlers without touching the hook', async () => {
    const ctx = buildContext();
    const onHomeScopedSettingChanged = vi.fn();

    const { handle } = initSettingsHandlerForApp(ctx, { onHomeScopedSettingChanged });
    await handle(CAPACITY_LIMIT_KW);

    expect(onHomeScopedSettingChanged).not.toHaveBeenCalled();
    expect(ctx.loadCapacitySettings).toHaveBeenCalled();
    expect(ctx.updateDailyBudgetState).toHaveBeenCalledWith({
      forcePlanRebuild: true,
      persistReason: 'manual',
    });
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
  it('loads the temperature-control disabled device map', () => {
    const settings = {
      get: vi.fn((key: string) => (
        key === TEMPERATURE_CONTROL_DISABLED_DEVICES
          ? { thermostat: true, heater: false }
          : undefined
      )),
    };

    const next = buildCapacitySettingsSnapshot({
      settings: settings as never,
      current: buildCapacitySnapshot(),
    });

    expect(next.temperatureControlDisabledDevices).toEqual({
      thermostat: true,
      heater: false,
    });
    expect(next.temperatureControlPolicyState).toBe('resolved');
  });

  it('resolves a genuinely absent fresh-install setting as an empty policy', () => {
    // `null` is what the SDK answers for a key that was never written. These
    // three specs drove `undefined` — a value only a test double produces —
    // which is why the reader shipped classifying absence on the wrong branch.
    const settings = {
      get: vi.fn(() => null),
      getKeys: vi.fn(() => ['some_other_setting']),
    };

    const next = buildCapacitySettingsSnapshot({
      settings: settings as never,
      current: buildCapacitySnapshot(),
    });

    expect(next.temperatureControlDisabledDevices).toEqual({});
    expect(next.temperatureControlPolicyState).toBe('resolved');
  });

  it('fails closed when the key is present but its value is unavailable', () => {
    const settings = {
      get: vi.fn(() => null),
      getKeys: vi.fn(() => [TEMPERATURE_CONTROL_DISABLED_DEVICES]),
    };

    const next = buildCapacitySettingsSnapshot({
      settings: settings as never,
      current: buildCapacitySnapshot(),
    });

    expect(next.temperatureControlDisabledDevices).toEqual({});
    expect(next.temperatureControlPolicyState).toBe('unavailable');
  });

  it('fails closed when an empty key list cannot prove fresh-install absence', () => {
    const settings = {
      get: vi.fn(() => null),
      getKeys: vi.fn(() => []),
    };

    const next = buildCapacitySettingsSnapshot({
      settings: settings as never,
      current: buildCapacitySnapshot(),
    });

    expect(next.temperatureControlDisabledDevices).toEqual({});
    expect(next.temperatureControlPolicyState).toBe('unavailable');
  });

  it('recovers an unavailable cold-boot policy after a later valid read', () => {
    let raw: unknown = { thermostat: 'invalid' };
    const settings = {
      get: vi.fn((key: string) => (
        key === TEMPERATURE_CONTROL_DISABLED_DEVICES ? raw : undefined
      )),
      getKeys: vi.fn(() => [TEMPERATURE_CONTROL_DISABLED_DEVICES]),
    };
    const unavailable = buildCapacitySettingsSnapshot({
      settings: settings as never,
      current: buildCapacitySnapshot(),
    });
    expect(unavailable.temperatureControlPolicyState).toBe('unavailable');

    raw = { thermostat: true };
    const recovered = buildCapacitySettingsSnapshot({
      settings: settings as never,
      current: unavailable,
    });

    expect(recovered.temperatureControlDisabledDevices).toEqual({ thermostat: true });
    expect(recovered.temperatureControlPolicyState).toBe('resolved');
  });

  it('retries an unavailable policy at command-authority read time', () => {
    let raw: unknown = { thermostat: 'invalid' };
    let devices: Record<string, boolean> = {};
    let policyState: 'unavailable' | 'resolved' = 'unavailable';
    const ctx = {
      homey: { settings: {
        get: () => raw,
        getKeys: () => [TEMPERATURE_CONTROL_DISABLED_DEVICES],
      } },
      get temperatureControlDisabledDevices() { return devices; },
      set temperatureControlDisabledDevices(value) { devices = value; },
      get temperatureControlPolicyState() { return policyState; },
      set temperatureControlPolicyState(value) { policyState = value; },
      deviceManager: { getSnapshotByDeviceId: () => ({ deviceType: 'temperature' }) },
    } as unknown as AppContext;
    ctx.loadTemperatureControlPolicySettings = () => loadTemperatureControlPolicySettingsForApp(ctx);

    expect(isTemperatureControlDisabledForApp(ctx, 'thermostat')).toBe(true);
    expect(ctx.temperatureControlPolicyState).toBe('unavailable');

    raw = {};
    expect(isTemperatureControlDisabledForApp(ctx, 'thermostat')).toBe(false);
    expect(ctx.temperatureControlPolicyState).toBe('resolved');
  });

  it('keeps the last-good temperature-control map when persisted data is invalid', () => {
    const settings = {
      get: vi.fn((key: string) => (
        key === TEMPERATURE_CONTROL_DISABLED_DEVICES
          ? { thermostat: 'yes' }
          : undefined
      )),
    };

    const next = buildCapacitySettingsSnapshot({
      settings: settings as never,
      current: buildCapacitySnapshot({
        temperatureControlDisabledDevices: { thermostat: true },
        temperatureControlPolicyState: 'resolved',
      }),
    });

    expect(next.temperatureControlDisabledDevices).toEqual({ thermostat: true });
    expect(next.temperatureControlPolicyState).toBe('resolved');
  });

  it('keeps the last-good temperature-control map when the settings read throws', () => {
    const settings = {
      get: vi.fn((key: string) => {
        if (key === TEMPERATURE_CONTROL_DISABLED_DEVICES) throw new Error('settings unavailable');
        return undefined;
      }),
    };

    const next = buildCapacitySettingsSnapshot({
      settings: settings as never,
      current: buildCapacitySnapshot({
        temperatureControlDisabledDevices: { thermostat: true },
        temperatureControlPolicyState: 'resolved',
      }),
    });

    expect(next.temperatureControlDisabledDevices).toEqual({ thermostat: true });
    expect(next.temperatureControlPolicyState).toBe('resolved');
  });

  it('resolves capacity scalars per field through the home-scoped store', () => {
    const settings = {
      get: vi.fn((key: string) => {
        if (key === CAPACITY_LIMIT_KW) return 8; // valid → wins
        if (key === CAPACITY_MARGIN_KW) return 'oops'; // junk → last-good
        if (key === CAPACITY_DRY_RUN) return 'yes'; // junk → last-good
        if (key === `${CAPACITY_LIMIT_KW}:cabin`) return 99; // suffixed decoy → invisible
        return undefined;
      }),
    };

    const next = buildCapacitySettingsSnapshot({
      settings: settings as never,
      current: buildCapacitySnapshot(),
    });

    expect(next.capacitySettings).toEqual({ limitKw: 8, marginKw: 0.5 });
    expect(next.capacityDryRun).toBe(false);
  });

  it('resolves a loaded set of devices to unique, deterministic priority per mode', () => {
    // Persisted payload is intentionally corrupt: duplicate priorities (a/b
    // both 5), a gap (jumps to 9), and an unordered key sequence.
    const settings = {
      get: vi.fn((key: string) => (
        key === 'capacity_priorities'
          ? { Home: { b: 5, a: 5, c: 9, d: 1 } }
          : undefined
      )),
    };

    const next = buildCapacitySettingsSnapshot({
      settings: settings as never,
      current: buildCapacitySnapshot(),
    });

    // Strict 1..N order; ties (a/b) break by deviceId; gaps closed.
    expect(next.capacityPriorities).toEqual({ Home: { d: 1, a: 2, b: 3, c: 4 } });
    const ranks = Object.values(next.capacityPriorities.Home);
    expect(new Set(ranks).size).toBe(ranks.length);
  });

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

  it('loads normalized target power configs from settings', () => {
    const settings = {
      get: vi.fn((key: string) => (
        key === DEVICE_TARGET_POWER_CONFIGS
          ? {
            ' device-a ': JSON.stringify({
              preset: 'ev_charger_1_phase',
              min: 0,
              max: 7360,
              step: 460,
              excludeMin: 1,
              excludeMax: 1380,
            }),
          }
          : undefined
      )),
    };

    const next = buildCapacitySettingsSnapshot({
      settings: settings as never,
      current: buildCapacitySnapshot(),
    });

    expect(next.deviceTargetPowerConfigs).toEqual({
      'device-a': {
        preset: 'ev_charger_1_phase',
        min: 0,
        max: 7360,
        step: 460,
        excludeMin: 1,
        excludeMax: 1380,
      },
    });
  });

  it('keeps valid target power configs when stale entries are present', () => {
    const settings = {
      get: vi.fn((key: string) => (
        key === DEVICE_TARGET_POWER_CONFIGS
          ? {
            charger: {
              enabled: true,
              preset: 'ev_charger_3_phase',
            },
            stale: null,
          }
          : undefined
      )),
    };

    const next = buildCapacitySettingsSnapshot({
      settings: settings as never,
      current: buildCapacitySnapshot({
        deviceTargetPowerConfigs: {
          old: { enabled: true, preset: 'ev_charger_1_phase' },
        },
      }),
    });

    expect(next.deviceTargetPowerConfigs).toEqual({
      charger: {
        enabled: true,
        preset: 'ev_charger_3_phase',
      },
    });
  });

  it('keeps current target power configs when persisted payload is malformed JSON', () => {
    const settings = {
      get: vi.fn((key: string) => (
        key === DEVICE_TARGET_POWER_CONFIGS
          ? '{"charger":{"enabled":true,"preset":"ev_charger_3_phase"'
          : undefined
      )),
    };

    const next = buildCapacitySettingsSnapshot({
      settings: settings as never,
      current: buildCapacitySnapshot({
        deviceTargetPowerConfigs: {
          charger: { enabled: true, preset: 'ev_charger_1_phase' },
        },
      }),
    });

    expect(next.deviceTargetPowerConfigs).toEqual({
      charger: { enabled: true, preset: 'ev_charger_1_phase' },
    });
  });
});
