import { createInertPlanRebuildThrottle } from '../helpers/powerRebuildScheduler';
import { createTrackerStore } from '../../lib/power/trackerStore';
import { IN_MEMORY_DATABASE, openUserdataDatabase } from '../../lib/store/userdataDatabase';
import { registerSettingsHandler } from '../../setup/appInit/registerSettingsHandler';
import type { AppContext } from '../../lib/app/appContext';
import type { HomeRuntimeRegistry } from '../../setup/homeRuntime/homeRuntimeRegistry';
import type { ShedAction } from '../../lib/plan/planTypes';
import type { DebugLoggingTopic } from '../../packages/shared-domain/src/utils/debugLogging';
import { TimerRegistry } from '../../lib/utils/timerRegistry';
import {
  CAPACITY_LIMIT_KW,
  CAPACITY_MARGIN_KW,
  HOMEY_ENERGY_METER_DEVICE_ID,
  POWER_SOURCE,
  TEMPERATURE_CONTROL_DISABLED_DEVICES,
} from '../../lib/utils/settingsKeys';

// One store for the file: no spec here persists a tracker, the context only needs the seam.
const trackerStore = createTrackerStore(openUserdataDatabase(IN_MEMORY_DATABASE));

const buildContext = () => {
  const settingsListeners = new Map<string, (...args: unknown[]) => Promise<void>>();
  const priceRefresh = vi.fn();
  const timers = new TimerRegistry();
  // Deliberate partial of the broad AppContext surface — this suite exercises the
  // settings-handler wiring, not the full context, so the unrelated flow-backed
  // capability methods are intentionally absent.
  const ctx = {
    homey: {
      settings: {
        get: vi.fn(),
        set: vi.fn(),
        on: vi.fn((event: string, listener: (...args: unknown[]) => Promise<void>) => {
          settingsListeners.set(event, listener);
        }),
        off: vi.fn((event: string, listener: (...args: unknown[]) => Promise<void>) => {
          if (settingsListeners.get(event) === listener) {
            settingsListeners.delete(event);
          }
        }),
      },
    } as never,
    log: vi.fn(),
    error: vi.fn(),
    getStructuredLogger: vi.fn(),
    getNow: () => new Date('2026-04-16T00:00:00.000Z'),
    getTimeZone: () => 'Europe/Oslo',
    notifyOperatingModeChanged: vi.fn(),
    hydratePowerTracker: vi.fn(),
    getTrackerStore: () => trackerStore,
    emitPowerTrackerPersisted: vi.fn(),
    capacitySettingsStore: {
      read: vi.fn(() => ({
        state: 'resolved' as const,
        value: {
          limitKw: 12,
          marginKw: 0.5,
          dryRun: false,
          periodMinutes: 60 as const,
        },
      })),
      readHardCapConfiguration: vi.fn(() => ({ state: 'resolved' as const, configured: true })),
      noteWrite: vi.fn(),
    },
    loadCapacitySettings: vi.fn(),
    noteCapacitySettingWritten: vi.fn(),
    recoverCapacitySettingsAfterSkippedWrite: vi.fn(),
    updateDebugLoggingEnabled: vi.fn(),
    reloadWeatherCollector: vi.fn(),
    updateOverheadToken: vi.fn(async () => undefined),
    registerFlowCards: vi.fn(),
    refreshTargetDevicesSnapshot: vi.fn(async () => undefined),
    recordPowerSample: vi.fn(async () => ({ state: 'admitted' as const, revision: 1 })),
    handleOperatingModeChange: vi.fn(async () => undefined),
    getFlowSnapshot: vi.fn(async () => []),
    getCurrentPriceLevel: vi.fn(),
    setExpectedOverride: vi.fn(() => false),
    loadDailyBudgetSettings: vi.fn(),
    updateDailyBudgetState: vi.fn(),
    resolveManagedState: vi.fn(() => false),
    isCapacityControlEnabled: vi.fn(() => false),
    getShedBehavior: vi.fn(() => ({ action: 'turn_off' as ShedAction, temperature: null, stepId: null })),
    computeDynamicSoftLimit: vi.fn(() => 0),
    getDynamicSoftLimitOverride: vi.fn(() => null),
    evaluateHeadroomForDevice: vi.fn(() => null),
    getDailyBudgetUiPayload: vi.fn(() => ({ kind: 'unavailable' as const })),
    getLatestPlanSnapshotForUi: vi.fn(() => null),
    get powerTracker() { return {}; },
    set powerTracker(_value) {},
    resetMainPowerTrackerFreshness: vi.fn(),
    get capacitySettings() { return { limitKw: 12, marginKw: 0.5, periodMinutes: 60 as const }; },
    set capacitySettings(_value) {},
    get capacityDryRun() { return false; },
    set capacityDryRun(_value) {},
    deviceControlSettings: { reloadTemperatureControlPolicy: vi.fn() },
    observedTemperatureModeUpdates: { consumeSettingChange: () => false },
    get debugLoggingTopics() { return new Set<DebugLoggingTopic>(); },
    set debugLoggingTopics(_value) {},
    get defaultComputeDynamicSoftLimit() { return undefined; },
    set defaultComputeDynamicSoftLimit(_value) {},
    get lastKnownPowerKw() { return {}; },
    get expectedPowerKwOverrides() { return {}; },
    get lastNotifiedOperatingMode() { return 'Home'; },
    set lastNotifiedOperatingMode(_value) {},
    get planRebuildThrottle() { return createInertPlanRebuildThrottle(); },
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
      invalidate: vi.fn(),
    } as never,
    deviceControlHelpers: {} as never,
    planService: {
      rebuildPlanFromCache: vi.fn(async () => undefined),
    } as never,
    batteryControl: {
      applyControlSettings: vi.fn(),
    } as never,
    externalOffHold: {
      releaseDeOptedHolds: vi.fn(() => []),
    } as never,
    timers,
  } as unknown as AppContext;
  return { ctx, settingsListeners };
};

/**
 * Register against the context, with the given home-runtime registry, and
 * return the settings `set` listener the registration installed: the specs
 * write through the same edge Homey drives.
 */
const register = (
  { ctx, settingsListeners }: ReturnType<typeof buildContext>,
  registry?: Partial<HomeRuntimeRegistry>,
): ((key: string) => Promise<void>) => {
  registerSettingsHandler(
    ctx, () => 'Home', () => registry as HomeRuntimeRegistry | undefined, vi.fn(), vi.fn(), () => {},
  );
  const listener = settingsListeners.get('set');
  if (!listener) throw new Error('registerSettingsHandler installed no set listener');
  return (key) => listener(key);
};

describe('registerSettingsHandler', () => {
  it('publishes the temperature-control policy at the synchronous settings edge', async () => {
    const rig = buildContext();
    const handle = register(rig);

    const handling = handle(TEMPERATURE_CONTROL_DISABLED_DEVICES);

    expect(rig.ctx.deviceControlSettings.reloadTemperatureControlPolicy).toHaveBeenCalledTimes(1);
    await handling;
  });

  it('routes daily budget updates through the app context callback', async () => {
    const rig = buildContext();

    await register(rig)(CAPACITY_LIMIT_KW);

    expect(rig.ctx.updateDailyBudgetState).toHaveBeenCalledWith({
      forcePlanRebuild: true,
      persistReason: 'manual',
    });
    expect(rig.ctx.dailyBudgetService?.updateState).not.toHaveBeenCalled();
  });

  it('routes home-suffixed writes to the hook instead of the main handlers', async () => {
    const rig = buildContext();
    const onHomeScopedSettingChanged = vi.fn();

    const handle = register(rig, { onHomeScopedSettingChanged });
    await handle(`${CAPACITY_MARGIN_KW}:cabin`);
    await handle(`${CAPACITY_LIMIT_KW}:cabin`);

    expect(onHomeScopedSettingChanged).toHaveBeenCalledTimes(2);
    expect(onHomeScopedSettingChanged).toHaveBeenNthCalledWith(1, CAPACITY_MARGIN_KW, 'cabin');
    expect(onHomeScopedSettingChanged).toHaveBeenNthCalledWith(2, CAPACITY_LIMIT_KW, 'cabin');
    // The critical invariant: a suffixed write must not run the main home's
    // handler for the base key (reload main's capacity settings).
    expect(rig.ctx.loadCapacitySettings).not.toHaveBeenCalled();
    expect(rig.ctx.updateDailyBudgetState).not.toHaveBeenCalled();
  });

  it('routes a global source change through the home-runtime epoch hook', async () => {
    const rig = buildContext();
    const onPowerSourceChanged = vi.fn();
    const handle = register(rig, { observePowerSourceChange: vi.fn(), onPowerSourceChanged });

    const handling = handle(POWER_SOURCE);

    expect(rig.ctx.resetMainPowerTrackerFreshness).toHaveBeenCalledTimes(1);
    await handling;
    expect(onPowerSourceChanged).toHaveBeenCalledTimes(1);
  });

  it('resets Main synchronously before handling a whole-home meter change', async () => {
    const rig = buildContext();
    const handle = register(rig);

    const handling = handle(HOMEY_ENERGY_METER_DEVICE_ID);

    expect(rig.ctx.resetMainPowerTrackerFreshness).toHaveBeenCalledTimes(1);
    await handling;
    expect(rig.ctx.homeyEnergyHelpers.restart).toHaveBeenCalledTimes(1);
  });

  it('dispatches unsuffixed keys to the main handlers without touching the hook', async () => {
    const rig = buildContext();
    const onHomeScopedSettingChanged = vi.fn();

    await register(rig, { onHomeScopedSettingChanged })(CAPACITY_LIMIT_KW);

    expect(onHomeScopedSettingChanged).not.toHaveBeenCalled();
    expect(rig.ctx.loadCapacitySettings).toHaveBeenCalled();
    expect(rig.ctx.updateDailyBudgetState).toHaveBeenCalledWith({
      forcePlanRebuild: true,
      persistReason: 'manual',
    });
  });

  it.each([
    ['priceCoordinator', 'PriceCoordinator must be initialized before use.'],
    ['planService', 'PlanService must be initialized before use.'],
    ['batteryControl', 'Battery control must be initialized before the plan stack and settings handler setup.'],
    ['dailyBudgetService', 'DailyBudgetService must be initialized before use.'],
    ['externalOffHold', 'The external-off hold policy must be initialized before the settings handler setup.'],
  ] as const)('fails fast when %s wiring is missing', (member, message) => {
    const rig = buildContext();
    delete rig.ctx[member];

    expect(() => register(rig)).toThrow(message);
  });
});
