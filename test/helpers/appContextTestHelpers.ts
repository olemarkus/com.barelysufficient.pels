import type { ConfiguredShedBehavior } from '../../packages/shared-domain/src/settings/shedBehaviors';
import { SurplusPoolReachability } from '../../lib/power/surplusPoolReachable';
import type { DeviceStartPolicy } from '../../packages/shared-domain/src/settings/deviceStartPolicy';
import { createDeviceReads, type DeviceReadStore } from '../../lib/device/deviceReads';
import { joinObservedDeviceDescriptors } from '../../lib/device/deviceReadSources';
import { DeviceConfigurationStore, createDeviceConfiguration } from '../../lib/device/deviceConfiguration';
import { SettingsUiDeviceReads } from '../../lib/device/settingsUiDeviceReads';
import { projectObservedState } from '../../lib/device/observedStateProjection';
import { readRuntimeDevices } from '../../lib/planInput/runtimeDeviceRead';
import { ObservedTemperatureModeUpdates } from '../../lib/home/observedTemperatureModeUpdates';
import { createTrackerStore } from '../../lib/power/trackerStore';
import { IN_MEMORY_DATABASE, openUserdataDatabase } from '../../lib/store/userdataDatabase';
import { NO_PRICE_SOURCE_PAYLOADS } from '../../lib/ports/settingsUiStatusSeams';
import type { LearnedPeaksByDeviceId } from '../../lib/device/devicePowerPeak';
import { steppedStoresForTest } from './steppedStores';
import { createInertPlanRebuildThrottle } from './powerRebuildScheduler';
import { vi } from 'vitest';
import {
  requireInitializedAppContext,
  type AppContext,
  type FlowBackedCapabilityReportOutcome,
  type InitializedAppContext,
} from '../../lib/app/appContext';
import { createDeviceControlHelpersForTest } from './deviceControlHelpers';
import { GenerationPollSource } from '../../lib/power/sources/generationPoll';
import { HomeyEnergyPollSource } from '../../lib/power/sources/homeyEnergyPoll';
import { AppSnapshotHelpers } from '../../setup/appSnapshotHelpers';
import { normalizePowerSource } from '../../lib/power/powerSource';
import { TimerRegistry } from '../../lib/utils/timerRegistry';
import { MeterSilenceMonitor } from '../../lib/power/meterSilence';
import { createCombinedPricesReader } from '../../lib/price/combinedPricesReader';
import { createPriceDataStore } from '../../lib/price/priceDataStore';
import { createPriceCacheStore } from '../../lib/price/priceCacheStore';
import type { PowerTrackerState } from '../../lib/power/tracker';
import type { DailyBudgetUiRead } from '../../lib/dailyBudget/dailyBudgetTypes';
import type { StructuredDebugEmitter } from '../../lib/logging/logger';
import { createPlanStatusRegistry } from '../../lib/plan/planStatusRegistry';
import type { PriceOptimizationSettings } from '../../lib/price/priceOptimizer';
import type { DebugLoggingTopic } from '../../packages/shared-domain/src/utils/debugLogging';
import type {
  DeviceControlProfiles,
  EvBoostSettings,
  EvCarAssociations,
  TemperatureBoostSettings,
  ThermalDirection,
} from '../../packages/contracts/src/types';
import type { TransportDeviceSnapshot } from '../../lib/device/transportDeviceSnapshot';
import type { FlowCard, FlowHomeyLike } from '../../lib/utils/types';
import type { SettingsUiPlanSnapshot } from '../../packages/contracts/src/settingsUiApi';
import { createEmptyPowerCalibrationSnapshot } from '../../lib/device/devicePowerCalibration';
import type { DeviceTargetPowerConfigsWithReachability } from '../../lib/device/targetPowerReachability';
import { PriceLevel } from '../../lib/price/priceLevels';
import type { HeadroomForDeviceDecision } from '../../lib/plan/planHeadroomDevice';
import { createHomeModeCatalog } from '../../lib/home/homeModeCatalog';
import { MAIN_HOME_ID } from '../../lib/utils/settingsKeys';
import {
  CAPACITY_PRIORITIES,
  MODE_ALIASES,
  MODE_DEVICE_TARGETS,
  OPERATING_MODE_SETTING,
} from '../../lib/utils/settingsKeys';
import type { HomeModeCatalog, HomeModeCatalogSnapshot } from '../../lib/home/homeModeCatalog';
import { buildMainHomeScope } from '../../setup/homeRuntime/homeScope';

const homeModeCatalogByContext = new WeakMap<AppContext, HomeModeCatalog>();

type MockHomey = FlowHomeyLike & {
  settings: FlowHomeyLike['settings'] & {
    on: (event: string, listener: (...args: unknown[]) => void) => void;
    off: (event: string, listener: (...args: unknown[]) => void) => void;
  };
  clock: {
    getTimezone: () => string;
  };
};

type AppContextMockOptions = Omit<Partial<AppContext>, 'priceOptimizationEnabled' | 'priceOptimizationSettings'> & {
  latestTargetSnapshot?: TransportDeviceSnapshot[];
  priceOptimizationEnabled?: boolean;
  priceOptimizationSettings?: Record<string, PriceOptimizationSettings>;
  modeCatalog?: Partial<HomeModeCatalogSnapshot>;
};

type MutableAppContextMock = AppContext & {
  latestTargetSnapshot: TransportDeviceSnapshot[];
};

export function configureHomeModeCatalog(
  context: AppContext,
  configuration: Partial<HomeModeCatalogSnapshot>,
): void {
  const { settings } = context.homey;
  if (configuration.operatingMode !== undefined) settings.set(OPERATING_MODE_SETTING, configuration.operatingMode);
  if (configuration.aliases !== undefined) settings.set(MODE_ALIASES, configuration.aliases);
  if (configuration.priorities !== undefined) settings.set(CAPACITY_PRIORITIES, configuration.priorities);
  if (configuration.targets !== undefined) settings.set(MODE_DEVICE_TARGETS, configuration.targets);
  getHomeModeCatalogForTest(context).reload();
}

export function getHomeModeCatalogForTest(context: AppContext): HomeModeCatalog {
  const catalog = homeModeCatalogByContext.get(context);
  if (!catalog) throw new Error('No test home mode catalog is registered for this context.');
  return catalog;
}

export function buildMainHomeScopeForTest(
  context: AppContext,
  isTornDown: () => boolean,
  isHomeWideFenced: () => boolean,
): ReturnType<typeof buildMainHomeScope> {
  const catalog = getHomeModeCatalogForTest(context);
  return buildMainHomeScope(
    context,
    (deviceIds) => catalog.getPrioritiesForDevices(deviceIds),
    () => catalog.getOperatingMode(),
    () => catalog.getModeDeviceTargets(),
    isTornDown,
    isHomeWideFenced,
  );
}

function createFlowCardMock(): FlowCard {
  return {
    registerRunListener: vi.fn(),
    registerArgumentAutocompleteListener: vi.fn(),
  };
}

export function createHomeyMock(): { appHomey: AppContext['homey']; flowHomey: MockHomey } {
  const values = new Map<string, unknown>([['__test_presence', true]]);
  const flowHomey: MockHomey = {
    flow: {
      getTriggerCard: vi.fn(() => createFlowCardMock()),
      getConditionCard: vi.fn(() => createFlowCardMock()),
      getActionCard: vi.fn(() => createFlowCardMock()),
    },
    settings: {
      // Unset keys answer `null`, as the SDK does — see test/mocks/homey.ts.
      get: vi.fn((key: string) => values.get(key) ?? null),
      set: vi.fn((key: string, value: unknown) => { values.set(key, value); }),
      unset: vi.fn((key: string) => { values.delete(key); }),
      getKeys: vi.fn(() => [...values.keys()]),
      on: vi.fn(),
      off: vi.fn(),
    },
    clock: {
      getTimezone: () => 'Europe/Oslo',
    },
  };
  return {
    appHomey: flowHomey as unknown as AppContext['homey'],
    flowHomey,
  };
}

export function createAppContextMock(options: AppContextMockOptions = {}): MutableAppContextMock {
  const {
    latestTargetSnapshot: latestTargetSnapshotOverride,
    priceOptimizationEnabled: priceOptimizationEnabledOverride,
    priceOptimizationSettings: priceOptimizationSettingsOverride,
    homey: homeyOverride,
    timers: timersOverride,
    snapshotHelpers: snapshotHelpersOverride,
    homeyEnergyHelpers: homeyEnergyHelpersOverride,
    deviceControlHelpers: deviceControlHelpersOverride,
    getStructuredDebugEmitter: getStructuredDebugEmitterOverride,
    modeCatalog: modeCatalogOverride,
    ...overrides
  } = options;

  const { appHomey } = createHomeyMock();
  const timers = timersOverride ?? new TimerRegistry();
  const homey = homeyOverride ?? appHomey;
  const structuredDebugEmitter: StructuredDebugEmitter = vi.fn();

  let powerTracker: PowerTrackerState = {};
  let capacitySettings = { limitKw: 12, marginKw: 0.5, periodMinutes: 60 as const };
  let capacityDryRun = false;
  let controllableDevices: Record<string, boolean> = {};
  let managedDevices: Record<string, boolean> = {};
  let budgetExemptDevices: Record<string, boolean> = {};
  let deviceStartPolicies: Record<string, DeviceStartPolicy> = {};
  let deviceDriverOverrides: Record<string, string> = {};
  let deviceControlProfiles: DeviceControlProfiles = {};
  let deviceTargetPowerConfigs: DeviceTargetPowerConfigsWithReachability = {};
  let temperatureBoostSettings: TemperatureBoostSettings = {};
  let temperatureControlDisabledDevices: Record<string, boolean> = {};
  let temperatureControlPolicyState: 'unavailable' | 'resolved' = 'resolved';
  let evBoostSettings: EvBoostSettings = {};
  let evCarAssociations: EvCarAssociations = {};
  let shedBehaviors: Record<string, ConfiguredShedBehavior> = {};
  let debugLoggingTopics = new Set<DebugLoggingTopic>();
  let defaultComputeDynamicSoftLimit: (() => number) | undefined;
  const lastKnownPowerKw: LearnedPeaksByDeviceId = {};
  let lastNotifiedOperatingMode = 'Home';
  const planRebuildThrottle = createInertPlanRebuildThrottle();
  let latestTargetSnapshot = latestTargetSnapshotOverride ?? [];
  const priceOptimizationEnabled = priceOptimizationEnabledOverride ?? false;
  const priceOptimizationSettings = priceOptimizationSettingsOverride ?? {};

  // Partial stand-in for the AppSnapshotHelpers deps: the test only wires the
  // subset of dependencies these helpers exercise. Cast to the constructor's
  // deps type so the partial mock satisfies the (wider) real interface.
  const snapshotHelpers = snapshotHelpersOverride ?? new AppSnapshotHelpers({
    getPowerSource: () => normalizePowerSource(homey.settings.get('power_source')),
    timers,
    getDeviceManager: () => undefined,
    getPlanEngine: () => undefined,
    getPlanService: () => undefined,
    getLatestTargetSnapshot: () => latestTargetSnapshot,
    resolveManagedState: () => false,
    isCapacityControlEnabled: () => false,
    getStructuredLogger: () => undefined,
    getNow: () => new Date('2026-04-16T00:00:00.000Z'),
    logPeriodicStatus: vi.fn(),
    seedTemperatureShedFloorDefaults: vi.fn(),
    getFlowReportedDeviceIds: vi.fn(() => []),
    emitFlowBackedRefreshRequests: vi.fn(async () => undefined),
    recordPowerSample: vi.fn(async () => undefined),
    // Automatic — the fixture has no explicit whole-home meter selection.
    resolveMainMeterSelection: () => ({ state: 'resolved', meterDeviceId: null }),
  } as unknown as ConstructorParameters<typeof AppSnapshotHelpers>[0]);
  const homeyEnergyHelpers = homeyEnergyHelpersOverride ?? new HomeyEnergyPollSource({
    getPowerSource: () => normalizePowerSource(homey.settings.get('power_source')),
    timers,
    pollHomePower: async () => null,
    recordPowerSample: vi.fn(async () => undefined),
    debugStructured: vi.fn(),
    error: vi.fn(),
  });
  const generationPollSource = new GenerationPollSource({
    getPowerSource: () => normalizePowerSource(homey.settings.get('power_source')),
    // No PV device in the default fixture, so the poll never reaches the SDK.
    hasProductionCandidate: () => latestTargetSnapshot.some((d) => d.deviceClass === 'solarpanel'),
    timers,
    readGenerationW: async () => ({ state: 'none' as const }),
    setGenerationW: vi.fn(),
    now: () => Date.now(),
    debugStructured: vi.fn(),
    error: vi.fn(),
  });
  const steppedStores = steppedStoresForTest();
  const deviceControlHelpers = deviceControlHelpersOverride ?? createDeviceControlHelpersForTest(
    () => latestTargetSnapshot, steppedStores, (deviceId) => deviceTargetPowerConfigs[deviceId],
    () => false, () => {}, () => null, { debugStructured: vi.fn() },
  );

  // The real inventory reads over the fixture go through production projections.
  // The mock's device fixture is `latestTargetSnapshot`, so the reads are backed
  // by THAT rather than by `context.deviceManager` — which most specs never set,
  // and which two helpers set to a partial stub. Without this a spec exercising
  // code that calls `deviceReads.descriptors()` / `.deviceIds()` sees zero
  // devices and passes vacuously while production sees the fixture.
  const deviceReadStore: DeviceReadStore = {
    getSnapshot: () => latestTargetSnapshot as unknown as TransportDeviceSnapshot[],
    getSnapshotByDeviceId: (deviceId) => (
      latestTargetSnapshot as unknown as TransportDeviceSnapshot[]
    ).find((device) => device.id === deviceId),
  };
  const deviceReads = createDeviceReads(() => deviceReadStore);
  const deviceConfigurationStore = new DeviceConfigurationStore();
  const getDeviceConfigurationStore = (): DeviceConfigurationStore => {
    deviceConfigurationStore.replace(latestTargetSnapshot as unknown as TransportDeviceSnapshot[]);
    return deviceConfigurationStore;
  };
  const settingsUiDeviceReads = new SettingsUiDeviceReads();
  settingsUiDeviceReads.connect({
    readChargerPhasePresets: () => ({ state: 'unavailable' }),
    readCarAssociationCandidates: () => ({ state: 'unavailable' }),
    getUiPickerDevices: () => latestTargetSnapshot as unknown as TransportDeviceSnapshot[],
  });
  const userdataDatabase = openUserdataDatabase(IN_MEMORY_DATABASE);
  const trackerStore = createTrackerStore(userdataDatabase);
  // The real component over the mock settings, observing this helper's tracker
  // the way the Main tracker component observes every state it adopts.
  const surplusPoolReachability = new SurplusPoolReachability(
    homey.settings,
    () => context.canContributeCurtailmentSurplus?.() === true,
  );
  surplusPoolReachability.observeExportEvidence(powerTracker);
  const homeModeCatalog = createHomeModeCatalog(
    MAIN_HOME_ID,
    homey.settings,
    () => homeModeCatalog.getSnapshot(),
    () => managedDevices,
    () => context.homeMembership,
    () => undefined,
  );
  const context: AppContext = {
    deviceReads,
    deviceConfiguration: createDeviceConfiguration(getDeviceConfigurationStore),
    // Composed the way production composes it (`setup/appHostApi.ts`
    // `getPlanInputSnapshot`): device configuration joined with the Observer
    // record, then decorated. It used to spread the whole fixture, which handed
    // the planner inventory metadata (the class) that production planner input
    // does not carry, and hid every consumer still reading it.
    getPlanInputSnapshot: () => context.deviceControlHelpers.decorateTargetSnapshotList(
      readRuntimeDevices(
        getDeviceConfigurationStore().getAll(),
        (deviceId) => context.getObservedRecord(deviceId),
      ),
    ),
    isSurplusPoolReachable: () => surplusPoolReachability.isReachable(),
    observedTemperatureModeUpdates: new ObservedTemperatureModeUpdates(
      homey.settings, () => ({ state: 'unavailable' }), () => false, vi.fn(), () => [], (_id, value) => value,
      () => false,
    ),
    startupBootstrap: undefined,
    getHomeyPriceFormulaUiStatus: () => ({ kind: 'none' as const }),
    getPowerhourSourceUiStatus: () => ({ kind: 'unknown' as const }),
    getPriceSourcePayloadsForUi: () => NO_PRICE_SOURCE_PAYLOADS,
    getPvForecastSourceUiStatus: () => ({ kind: 'unknown' }),
    homey,
    getCombinedPricesForUi: () => null,
    log: vi.fn(),
    error: vi.fn(),
    logDebug: vi.fn(),
    getStructuredLogger: vi.fn(() => undefined),
    getStructuredDebugEmitter: getStructuredDebugEmitterOverride ?? vi.fn(() => structuredDebugEmitter),
    getNow: () => new Date('2026-04-16T00:00:00.000Z'),
    getTimeZone: () => 'Europe/Oslo',
    capacitySettingsStore: {
      read: () => ({
        state: 'resolved',
        value: { ...capacitySettings, dryRun: capacityDryRun },
      }),
      readHardCapConfiguration: () => ({ state: 'resolved', configured: true }),
    },
    getCapacityScalars: () => ({ ...capacitySettings, dryRun: capacityDryRun }),
    getCurrentMonthCapacityPeakKw: () => null,
    notifyOperatingModeChanged: vi.fn(),
    hydratePowerTracker: vi.fn(),
    getTrackerStore: () => trackerStore,
    getUserdataDatabase: () => userdataDatabase,
    emitPowerTrackerPersisted: vi.fn(),
    loadCapacitySettings: vi.fn(),
    loadTemperatureControlPolicySettings: vi.fn(),
    loadPriceOptimizationSettings: vi.fn(),
    updatePriceOptimizationEnabled: vi.fn(),
    updateDebugLoggingEnabled: vi.fn(),
    updateOverheadToken: vi.fn(async () => undefined),
    registerFlowCards: vi.fn(),
    refreshTargetDevicesSnapshot: vi.fn(async () => undefined),
    recordPowerSample: vi.fn(async () => ({ state: 'admitted' as const, revision: 1 })),
    handleOperatingModeChange: vi.fn(async () => undefined),
    getFlowSnapshot: vi.fn(async () => []),
    getCurrentHourPriceLevel: vi.fn(() => PriceLevel.UNKNOWN),
    getPriceLevelChangesWithin: vi.fn(() => ({ state: 'resolved' as const, levels: [] })),
    areFlowBackedCardsAvailable: vi.fn(() => false),
    setExpectedOverride: vi.fn(() => false),
    reloadExpectedPowerOverrides: vi.fn(),
    storeFlowPriceData: vi.fn(),
    loadDailyBudgetSettings: vi.fn(),
    updateDailyBudgetState: vi.fn(),
    getFlowReportedCapabilitiesForDevice: vi.fn(() => ({})),
    getFlowReportedDeviceIds: vi.fn(() => []),
    reportFlowBackedCapability: vi.fn(() => defaultFlowBackedCapabilityReportOutcome),
    getHomeyDevicesForFlow: vi.fn(async () => []),
    emitFlowBackedRefreshRequests: vi.fn(async () => undefined),
    resolveManagedState: vi.fn(() => false),
    getObservedState: vi.fn(() => undefined),
    getObservedRecord: (deviceId: string) => {
      const snapshot = latestTargetSnapshot.find((device) => device.id === deviceId);
      return snapshot ? projectObservedState(snapshot as unknown as TransportDeviceSnapshot) : undefined;
    },
    getDeviceSurfaces: () => joinObservedDeviceDescriptors(
      deviceReads.descriptors(),
      (deviceId) => {
        const snapshot = latestTargetSnapshot.find((device) => device.id === deviceId);
        return snapshot ? projectObservedState(snapshot as unknown as TransportDeviceSnapshot) : undefined;
      },
    ),
    getFlowDeviceDescriptors: vi.fn(async () => []),
    getDeviceDescriptors: vi.fn(() => []),
    getDeviceDescriptor: vi.fn(() => undefined),
    // One stub per named cluster read. Each states ABSENCE explicitly rather than
    // leaning on `getObservedState` returning nothing — which is the point of the
    // split: the record no longer answers these questions.
    getObservedStateOfCharge: vi.fn(() => ({ kind: 'absent' } as const)),
    getObservedTemperature: vi.fn(() => ({ kind: 'absent' } as const)),
    getThermalDirection: vi.fn((): ThermalDirection => 'heating'),
    isLiveMeasuredDraw: vi.fn(() => true),
    getObservedEvChargingState: vi.fn(() => ({ kind: 'absent' } as const)),
    getObservationRevision: vi.fn(() => 0),
    isCapacityControlEnabled: vi.fn(() => false),
    isTemperatureControlDisabled: vi.fn(() => false),
    isBudgetExempt: vi.fn(() => false),
    getTemperatureBoostConfig: vi.fn(() => undefined),
    getEvBoostConfig: vi.fn(() => undefined),
    getShedBehavior: vi.fn((): ReturnType<AppContext['getShedBehavior']> => ({ action: 'turn_off' })),
    computeDynamicSoftLimit: vi.fn(() => 0),
    getDynamicSoftLimitOverride: vi.fn(() => null),
    evaluateHeadroomForDevice: vi.fn<() => HeadroomForDeviceDecision>(),
    getCombinedHourlyPrices: vi.fn(() => []),
    getDailyBudgetUiPayload: vi.fn((): DailyBudgetUiRead => ({ kind: 'unavailable' })),
    getLatestPlanSnapshotForUi: vi.fn((): SettingsUiPlanSnapshot | null => null),
    getPowerCalibrationSnapshot: vi.fn(() => createEmptyPowerCalibrationSnapshot()),
    get powerTracker() { return powerTracker; },
    set powerTracker(value) { powerTracker = value; surplusPoolReachability.observeExportEvidence(value); },
    resetMainPowerTrackerFreshness: vi.fn(),
    meterSilenceMonitor: new MeterSilenceMonitor({
      homeId: MAIN_HOME_ID,
      getPowerTracker: () => powerTracker,
      nowMs: () => Date.now(),
      structuredLog: () => undefined,
    }),
    get capacitySettings() { return capacitySettings; },
    set capacitySettings(value) { capacitySettings = value; },
    get capacityDryRun() { return capacityDryRun; },
    set capacityDryRun(value) { capacityDryRun = value; },
    get controllableDevices() { return controllableDevices; },
    set controllableDevices(value) { controllableDevices = value; },
    get managedDevices() { return managedDevices; },
    set managedDevices(value) { managedDevices = value; },
    get budgetExemptDevices() { return budgetExemptDevices; },
    set budgetExemptDevices(value) { budgetExemptDevices = value; },
    get deviceStartPolicies() { return deviceStartPolicies; },
    set deviceStartPolicies(value) { deviceStartPolicies = value; },
    get temperatureControlDisabledDevices() { return temperatureControlDisabledDevices; },
    set temperatureControlDisabledDevices(value) { temperatureControlDisabledDevices = value; },
    get temperatureControlPolicyState() { return temperatureControlPolicyState; },
    set temperatureControlPolicyState(value) { temperatureControlPolicyState = value; },
    get deviceDriverOverrides() { return deviceDriverOverrides; },
    set deviceDriverOverrides(value) { deviceDriverOverrides = value; },
    get deviceControlProfiles() { return deviceControlProfiles; },
    set deviceControlProfiles(value) { deviceControlProfiles = value; },
    get deviceTargetPowerConfigs() { return deviceTargetPowerConfigs; },
    set deviceTargetPowerConfigs(value) { deviceTargetPowerConfigs = value; },
    get temperatureBoostSettings() { return temperatureBoostSettings; },
    set temperatureBoostSettings(value) { temperatureBoostSettings = value; },
    get evBoostSettings() { return evBoostSettings; },
    set evBoostSettings(value) { evBoostSettings = value; },
    get evCarAssociations() { return evCarAssociations; },
    set evCarAssociations(value) { evCarAssociations = value; },
    get shedBehaviors() { return shedBehaviors; },
    set shedBehaviors(value) { shedBehaviors = value; },
    get debugLoggingTopics() { return debugLoggingTopics; },
    set debugLoggingTopics(value) { debugLoggingTopics = value; },
    get defaultComputeDynamicSoftLimit() { return defaultComputeDynamicSoftLimit; },
    set defaultComputeDynamicSoftLimit(value) { defaultComputeDynamicSoftLimit = value; },
    get lastKnownPowerKw() { return lastKnownPowerKw; },
    get expectedPowerKwOverrides() { return {}; },
    get lastNotifiedOperatingMode() { return lastNotifiedOperatingMode; },
    set lastNotifiedOperatingMode(value) { lastNotifiedOperatingMode = value; },
    get planRebuildThrottle() { return planRebuildThrottle; },
    getUiPickerDevices: () => latestTargetSnapshot,
    settingsUiDeviceReads,
    getCreateSmartTaskCandidateDevices: () => ({ state: 'ready', devices: latestTargetSnapshot }),
    get priceOptimizationEnabled() { return priceOptimizationEnabled; },
    get priceOptimizationSettings() { return priceOptimizationSettings; },
    // Mirror the real `DeferredObjectiveStatusBus` surface. The lifecycle emitter
    // reads `getCurrent`/`hasActive` and writes via `publish`/`setCurrent`, so a
    // `{ subscribe, emit }` shim crashes any code that touches the bus. Default
    // reads return "no active objective"; writers are inert spies.
    planStatuses: createPlanStatusRegistry(),
    deferredObjectiveStatusBus: {
      publish: vi.fn(),
      setCurrent: vi.fn(),
      forgetDevice: vi.fn(),
      getCurrent: vi.fn(() => null),
      hasActive: vi.fn(() => false),
      listDeviceIds: vi.fn(() => []),
      onTransition: vi.fn(() => () => {}),
    } as never,
    deferredObjectivePlanRevisionBus: { subscribe: vi.fn(() => () => {}), emit: vi.fn() } as never,
    deferredObjectiveEndedBus: { subscribe: vi.fn(() => () => {}), emit: vi.fn() } as never,
    deferredObjectiveHoursRemainingBus: { subscribe: vi.fn(() => () => {}), emit: vi.fn() } as never,
    // Mirror the real `DeferredObjectiveHoursRemainingTracker` surface
    // (`observe` + `forgetDevice`); `disableDeferredObjectiveInSettings` calls
    // `forgetDevice`, so the mock must expose it or the disable path crashes.
    deferredObjectiveHoursRemainingTracker: { observe: vi.fn(), forgetDevice: vi.fn() } as never,
    // Matches what the guard actually exposes now: the hard-cap incident, no
    // power and no thresholds.
    capacityGuard: {
      isInShortfall: vi.fn(() => false),
      getCurrentIncidentId: vi.fn(() => null),
      recordPlanVerdict: vi.fn(async () => undefined),
      recordReading: vi.fn(async () => undefined),
      recordCompletePeriodReading: vi.fn(async () => undefined),
      isShortfallAlertConditionActive: vi.fn(() => false),
    } as never,
    dailyBudgetService: {
      loadSettings: vi.fn(),
      updateState: vi.fn(),
      resetLearning: vi.fn(),
      getSnapshot: vi.fn(() => null),
    } as never,
    batteryControl: {
      admitClaim: vi.fn(() => ({ status: 'refused' as const, reason: 'not_drivable' as const })),
      onSnapshotCommitted: vi.fn(),
      applyControlSettings: vi.fn(),
    },
    priceCoordinator: {
      // The reader every combined-prices consumer takes from the coordinator,
      // over an empty in-memory price cache.
      combinedPricesReader: createCombinedPricesReader(
        createPriceDataStore(homey.settings, createPriceCacheStore(userdataDatabase)),
        () => undefined,
      ),
      refreshSpotPrices: vi.fn(async () => undefined),
      refreshGridTariffData: vi.fn(async () => undefined),
      startPriceRefresh: vi.fn(),
      getCurrentHourPriceLevel: vi.fn(() => PriceLevel.UNKNOWN),
    } as never,
    planService: {
      rebuildPlanFromCache: vi.fn(async () => undefined),
      evaluateHeadroomForDevice: vi.fn<() => HeadroomForDeviceDecision>(),
      syncLivePlanStateInline: vi.fn(() => false),
    } as never,
    snapshotHelpers,
    homeyEnergyHelpers,
    generationPollSource,
    deviceControlHelpers,
    steppedCommandStore: steppedStores.store,
    steppedReportedStore: steppedStores.reportedStore,
    timers,
  };

  Object.defineProperty(context, 'latestTargetSnapshot', {
    get: () => latestTargetSnapshot,
    set: (snapshot: TransportDeviceSnapshot[]) => { latestTargetSnapshot = snapshot; },
  });

  Object.assign(context, overrides);
  homeModeCatalogByContext.set(context, homeModeCatalog);
  if (modeCatalogOverride) configureHomeModeCatalog(context, modeCatalogOverride);
  return context as MutableAppContextMock;
}

/** A live-phase context with the smallest service surfaces used by lifecycle tests. */
export function createInitializedAppContextMock(options: AppContextMockOptions = {}): InitializedAppContext {
  const context = createAppContextMock({
    deviceDiagnosticsService: {
      getCurrentStarvedDeviceCount: vi.fn(() => 0),
    } as never,
    deviceManager: {
      getSnapshot: vi.fn(() => []),
      getPeriodicStatusMetrics: vi.fn(() => null),
    } as never,
    planEngine: {
      state: { sheddingActive: false },
    } as never,
    ...options,
  });
  requireInitializedAppContext(context);
  return context;
}
  const defaultFlowBackedCapabilityReportOutcome: FlowBackedCapabilityReportOutcome = {
    kind: 'state_changed',
    valueChanged: true,
    freshnessAdvanced: true,
    refreshSnapshot: true,
  };
