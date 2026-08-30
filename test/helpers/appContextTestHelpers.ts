import type { LearnedPeaksByDeviceId } from '../../lib/device/devicePowerPeak';
import { vi } from 'vitest';
import {
  requireInitializedAppContext,
  type AppContext,
  type FlowBackedCapabilityReportOutcome,
  type InitializedAppContext,
} from '../../lib/app/appContext';
import { AppDeviceControlHelpers } from '../../setup/appDeviceControlHelpers';
import { createSteppedCommandStore } from '../../lib/executor/steppedCommandStore';
import { GenerationPollSource } from '../../lib/power/sources/generationPoll';
import { HomeyEnergyPollSource } from '../../lib/power/sources/homeyEnergyPoll';
import { AppSnapshotHelpers } from '../../setup/appSnapshotHelpers';
import { normalizePowerSource } from '../../lib/power/powerSource';
import { TimerRegistry } from '../../lib/utils/timerRegistry';
import { createCombinedPricesReader } from '../../setup/priceCombinedPricesAdapter';
import type { PowerTrackerState } from '../../lib/power/tracker';
import type { DailyBudgetUiPayload } from '../../lib/dailyBudget/dailyBudgetTypes';
import type { StructuredDebugEmitter } from '../../lib/logging/logger';
import type { ShedBehavior } from '../../lib/plan/planTypes';
import type { PriceOptimizationSettings } from '../../lib/price/priceOptimizer';
import type { DebugLoggingTopic } from '../../packages/shared-domain/src/utils/debugLogging';
import type {
  DeviceControlProfiles,
  EvBoostSettings,
  EvCarAssociations,
  TemperatureBoostSettings,
} from '../../packages/contracts/src/types';
import type { TransportDeviceSnapshot } from '../../lib/device/transportDeviceSnapshot';
import type { FlowCard, FlowHomeyLike } from '../../lib/utils/types';
import type { SettingsUiPlanSnapshot } from '../../packages/contracts/src/settingsUiApi';
import { createEmptyPowerCalibrationSnapshot } from '../../lib/device/devicePowerCalibration';
import type { DeviceTargetPowerConfigsWithReachability } from '../../lib/device/targetPowerReachability';

type MockHomey = FlowHomeyLike & {
  settings: FlowHomeyLike['settings'] & {
    on: (event: string, listener: (...args: unknown[]) => void) => void;
    off: (event: string, listener: (...args: unknown[]) => void) => void;
  };
  clock: {
    getTimezone: () => string;
  };
};

type AppContextMockOptions = Omit<Partial<AppContext>, 'latestTargetSnapshot' | 'priceOptimizationEnabled' | 'priceOptimizationSettings'> & {
  latestTargetSnapshot?: TransportDeviceSnapshot[];
  priceOptimizationEnabled?: boolean;
  priceOptimizationSettings?: Record<string, PriceOptimizationSettings>;
};

function createFlowCardMock(): FlowCard {
  return {
    registerRunListener: vi.fn(),
    registerArgumentAutocompleteListener: vi.fn(),
  };
}

export function createHomeyMock(): { appHomey: AppContext['homey']; flowHomey: MockHomey } {
  const flowHomey: MockHomey = {
    flow: {
      getTriggerCard: vi.fn(() => createFlowCardMock()),
      getConditionCard: vi.fn(() => createFlowCardMock()),
      getActionCard: vi.fn(() => createFlowCardMock()),
    },
    settings: {
      // Unset keys answer `null`, as the SDK does — see test/mocks/homey.ts.
      get: vi.fn(() => null),
      set: vi.fn(),
      unset: vi.fn(),
      getKeys: vi.fn(() => []),
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

export function createAppContextMock(options: AppContextMockOptions = {}): AppContext {
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
    ...overrides
  } = options;

  const { appHomey } = createHomeyMock();
  const timers = timersOverride ?? new TimerRegistry();
  const homey = homeyOverride ?? appHomey;
  const structuredDebugEmitter: StructuredDebugEmitter = vi.fn();

  let powerTracker: PowerTrackerState = {};
  let capacitySettings = { limitKw: 12, marginKw: 0.5 };
  let capacityDryRun = false;
  let operatingMode = 'Home';
  let modeAliases: Record<string, string> = {};
  let capacityPriorities: Record<string, Record<string, number>> = {};
  let modeDeviceTargets: Record<string, Record<string, number>> = {};
  let controllableDevices: Record<string, boolean> = {};
  let managedDevices: Record<string, boolean> = {};
  let budgetExemptDevices: Record<string, boolean> = {};
  let deviceDriverOverrides: Record<string, string> = {};
  let deviceControlProfiles: DeviceControlProfiles = {};
  let deviceTargetPowerConfigs: DeviceTargetPowerConfigsWithReachability = {};
  let temperatureBoostSettings: TemperatureBoostSettings = {};
  let temperatureControlDisabledDevices: Record<string, boolean> = {};
  let temperatureControlPolicyState: 'unavailable' | 'resolved' = 'resolved';
  let evBoostSettings: EvBoostSettings = {};
  let evCarAssociations: EvCarAssociations = {};
  let deviceCommunicationModels: Record<string, 'local' | 'cloud'> = {};
  let shedBehaviors: Record<string, ShedBehavior> = {};
  let debugLoggingTopics = new Set<DebugLoggingTopic>();
  let defaultComputeDynamicSoftLimit: (() => number) | undefined;
  const lastKnownPowerKw: LearnedPeaksByDeviceId = {};
  let lastNotifiedOperatingMode = 'Home';
  let powerSampleRebuildState = { lastMs: 0, lastRebuildPowerW: 0 };
  const latestTargetSnapshot = latestTargetSnapshotOverride ?? [];
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
    disableUnsupportedDevices: vi.fn(),
    getFlowReportedDeviceIds: vi.fn(() => []),
    emitFlowBackedRefreshRequests: vi.fn(async () => undefined),
    recordPowerSample: vi.fn(async () => undefined),
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
    readGenerationW: async () => ({ state: 'resolved' as const, generationW: null }),
    setGenerationW: vi.fn(),
    now: () => Date.now(),
    debugStructured: vi.fn(),
    error: vi.fn(),
  });
  const deviceControlHelpers = deviceControlHelpersOverride ?? new AppDeviceControlHelpers({
    store: createSteppedCommandStore(),
    getProfiles: () => deviceControlProfiles,
    getDeviceSnapshots: () => latestTargetSnapshot,
    getStructuredLogger: () => undefined,
    debugStructured: vi.fn(),
  });

  const context: AppContext = {
    startupBootstrap: undefined,
    homey,
    combinedPricesReader: createCombinedPricesReader({ homey, requestRefetch: () => undefined }),
    log: vi.fn(),
    error: vi.fn(),
    logDebug: vi.fn(),
    getStructuredLogger: vi.fn(() => undefined),
    getStructuredDebugEmitter: getStructuredDebugEmitterOverride ?? vi.fn(() => structuredDebugEmitter),
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
    handleOperatingModeChange: vi.fn(async () => undefined),
    getFlowSnapshot: vi.fn(async () => []),
    getCurrentPriceLevel: vi.fn(),
    getCurrentHourPriceLevel: vi.fn(() => ({ cheap: false, expensive: false })),
    areFlowBackedCardsAvailable: vi.fn(() => false),
    setExpectedOverride: vi.fn(() => false),
    reloadExpectedPowerOverrides: vi.fn(),
    storeFlowPriceData: vi.fn(),
    loadDailyBudgetSettings: vi.fn(),
    updateDailyBudgetState: vi.fn(),
    requestFlowPlanRebuild: vi.fn(),
    getFlowReportedCapabilitiesForDevice: vi.fn(() => ({})),
    getFlowReportedDeviceIds: vi.fn(() => []),
    reportFlowBackedCapability: vi.fn(() => defaultFlowBackedCapabilityReportOutcome),
    getHomeyDevicesForFlow: vi.fn(async () => []),
    emitFlowBackedRefreshRequests: vi.fn(async () => undefined),
    resolveModeName: vi.fn((name: string) => name),
    getAllModes: vi.fn(() => new Set<string>()),
    resolveManagedState: vi.fn(() => false),
    getObservedState: vi.fn(() => undefined),
    getObservationRevision: vi.fn(() => 0),
    seedObservedStateFromSnapshot: vi.fn(),
    getCommunicationModel: vi.fn((): 'local' | 'cloud' => 'local'),
    isCapacityControlEnabled: vi.fn(() => false),
    isTemperatureControlDisabled: vi.fn(() => false),
    isBudgetExempt: vi.fn(() => false),
    getTemperatureBoostConfig: vi.fn(() => undefined),
    getEvBoostConfig: vi.fn(() => undefined),
    getShedBehavior: vi.fn((): ReturnType<AppContext['getShedBehavior']> => ({ action: 'turn_off' })),
    computeDynamicSoftLimit: vi.fn(() => 0),
    getDynamicSoftLimitOverride: vi.fn(() => null),
    evaluateHeadroomForDevice: vi.fn(() => null),
    getCombinedHourlyPrices: vi.fn(() => []),
    getDailyBudgetUiPayload: vi.fn((): DailyBudgetUiPayload | null => null),
    getLatestPlanSnapshotForUi: vi.fn((): SettingsUiPlanSnapshot | null => null),
    getPowerCalibrationSnapshot: vi.fn(() => createEmptyPowerCalibrationSnapshot()),
    get powerTracker() { return powerTracker; },
    set powerTracker(value) { powerTracker = value; },
    get capacitySettings() { return capacitySettings; },
    set capacitySettings(value) { capacitySettings = value; },
    get capacityDryRun() { return capacityDryRun; },
    set capacityDryRun(value) { capacityDryRun = value; },
    get operatingMode() { return operatingMode; },
    set operatingMode(value) { operatingMode = value; },
    get modeAliases() { return modeAliases; },
    set modeAliases(value) { modeAliases = value; },
    get capacityPriorities() { return capacityPriorities; },
    set capacityPriorities(value) { capacityPriorities = value; },
    get modeDeviceTargets() { return modeDeviceTargets; },
    set modeDeviceTargets(value) { modeDeviceTargets = value; },
    get controllableDevices() { return controllableDevices; },
    set controllableDevices(value) { controllableDevices = value; },
    get managedDevices() { return managedDevices; },
    set managedDevices(value) { managedDevices = value; },
    get budgetExemptDevices() { return budgetExemptDevices; },
    set budgetExemptDevices(value) { budgetExemptDevices = value; },
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
    get deviceCommunicationModels() { return deviceCommunicationModels; },
    set deviceCommunicationModels(value) { deviceCommunicationModels = value; },
    get shedBehaviors() { return shedBehaviors; },
    set shedBehaviors(value) { shedBehaviors = value; },
    get debugLoggingTopics() { return debugLoggingTopics; },
    set debugLoggingTopics(value) { debugLoggingTopics = value; },
    get defaultComputeDynamicSoftLimit() { return defaultComputeDynamicSoftLimit; },
    set defaultComputeDynamicSoftLimit(value) { defaultComputeDynamicSoftLimit = value; },
    get lastKnownPowerKw() { return lastKnownPowerKw; },
    get expectedPowerKwOverrides() { return {}; },
    get lastPositiveMeasuredPowerKw() { return {}; },
    get lastNotifiedOperatingMode() { return lastNotifiedOperatingMode; },
    set lastNotifiedOperatingMode(value) { lastNotifiedOperatingMode = value; },
    get powerSampleRebuildState() { return powerSampleRebuildState; },
    set powerSampleRebuildState(value) { powerSampleRebuildState = value; },
    get latestTargetSnapshot() { return latestTargetSnapshot; },
    getUiPickerDevices: () => latestTargetSnapshot,
    getCreateSmartTaskCandidateDevices: () => ({ state: 'ready', devices: latestTargetSnapshot }),
    get priceOptimizationEnabled() { return priceOptimizationEnabled; },
    get priceOptimizationSettings() { return priceOptimizationSettings; },
    // Mirror the real `DeferredObjectiveStatusBus` surface. The lifecycle emitter
    // reads `getCurrent`/`hasActive` and writes via `publish`/`setCurrent`, so a
    // `{ subscribe, emit }` shim crashes any code that touches the bus. Default
    // reads return "no active objective"; writers are inert spies.
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
      checkShortfall: vi.fn(async () => undefined),
      isShortfallAlertConditionActive: vi.fn(() => false),
    } as never,
    dailyBudgetService: {
      loadSettings: vi.fn(),
      updateState: vi.fn(),
      resetLearning: vi.fn(),
      getSnapshot: vi.fn(() => null),
    } as never,
    priceCoordinator: {
      initOptimizer: vi.fn(),
      refreshSpotPrices: vi.fn(async () => undefined),
      refreshGridTariffData: vi.fn(async () => undefined),
      startPriceRefresh: vi.fn(),
      startPriceOptimization: vi.fn(async () => undefined),
      getCurrentHourPriceLevel: vi.fn(() => ({ cheap: false, expensive: false })),
    } as never,
    planService: {
      rebuildPlanFromCache: vi.fn(async () => undefined),
      evaluateHeadroomForDevice: vi.fn(() => null),
      syncLivePlanStateInline: vi.fn(() => false),
    } as never,
    snapshotHelpers,
    homeyEnergyHelpers,
    generationPollSource,
    deviceControlHelpers,
    timers,
  };

  Object.assign(context, overrides);
  return context;
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
    rebuildPlan: true,
  };
