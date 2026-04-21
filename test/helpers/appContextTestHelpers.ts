import { vi } from 'vitest';
import type { AppContext, FlowBackedCapabilityReportOutcome } from '../../lib/app/appContext';
import { AppDeviceControlHelpers } from '../../lib/app/appDeviceControlHelpers';
import { AppHomeyEnergyHelpers } from '../../lib/app/appHomeyEnergyHelpers';
import { AppSnapshotHelpers } from '../../lib/app/appSnapshotHelpers';
import { TimerRegistry } from '../../lib/app/timerRegistry';
import type { PowerTrackerState } from '../../lib/core/powerTracker';
import type { DailyBudgetUiPayload } from '../../lib/dailyBudget/dailyBudgetTypes';
import type { StructuredDebugEmitter } from '../../lib/logging/logger';
import type { DevicePlan, ShedBehavior } from '../../lib/plan/planTypes';
import type { PriceOptimizationSettings } from '../../lib/price/priceOptimizer';
import type { DebugLoggingTopic } from '../../lib/utils/debugLogging';
import type { DeviceControlProfiles, FlowCard, FlowHomeyLike, TargetDeviceSnapshot } from '../../lib/utils/types';

type MockHomey = FlowHomeyLike & {
  settings: FlowHomeyLike['settings'] & {
    on: (event: string, listener: (...args: unknown[]) => void) => void;
    off: (event: string, listener: (...args: unknown[]) => void) => void;
  };
};

type AppContextMockOptions = Omit<Partial<AppContext>, 'latestTargetSnapshot' | 'priceOptimizationEnabled' | 'priceOptimizationSettings'> & {
  latestTargetSnapshot?: TargetDeviceSnapshot[];
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
      get: vi.fn(),
      set: vi.fn(),
      on: vi.fn(),
      off: vi.fn(),
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
  let deviceControlProfiles: DeviceControlProfiles = {};
  let deviceCommunicationModels: Record<string, 'local' | 'cloud'> = {};
  let experimentalEvSupportEnabled = false;
  let shedBehaviors: Record<string, ShedBehavior> = {};
  let debugLoggingTopics = new Set<DebugLoggingTopic>();
  let defaultComputeDynamicSoftLimit: (() => number) | undefined;
  let lastNotifiedOperatingMode = 'Home';
  let powerSampleRebuildState = { lastMs: 0, lastRebuildPowerW: 0 };
  const latestTargetSnapshot = latestTargetSnapshotOverride ?? [];
  const priceOptimizationEnabled = priceOptimizationEnabledOverride ?? false;
  const priceOptimizationSettings = priceOptimizationSettingsOverride ?? {};

  const snapshotHelpers = snapshotHelpersOverride ?? new AppSnapshotHelpers({
    homey,
    timers,
    getDeviceManager: () => undefined,
    getPlanEngine: () => undefined,
    getPlanService: () => undefined,
    getLatestTargetSnapshot: () => latestTargetSnapshot,
    resolveManagedState: () => false,
    isCapacityControlEnabled: () => false,
    getStructuredLogger: () => undefined,
    logDebug: vi.fn(),
    error: vi.fn(),
    getNow: () => new Date('2026-04-16T00:00:00.000Z'),
    logPeriodicStatus: vi.fn(),
    disableUnsupportedDevices: vi.fn(),
    getFlowReportedDeviceIds: vi.fn(() => []),
    emitFlowBackedRefreshRequests: vi.fn(async () => undefined),
    recordPowerSample: vi.fn(async () => undefined),
  });
  const homeyEnergyHelpers = homeyEnergyHelpersOverride ?? new AppHomeyEnergyHelpers({
    homey,
    timers,
    getDeviceManager: () => undefined,
    recordPowerSample: vi.fn(async () => undefined),
    logDebug: vi.fn(),
    error: vi.fn(),
  });
  const deviceControlHelpers = deviceControlHelpersOverride ?? new AppDeviceControlHelpers({
    getProfiles: () => deviceControlProfiles,
    getDeviceSnapshots: () => latestTargetSnapshot,
    getStructuredLogger: () => undefined,
    logDebug: vi.fn(),
  });

  const context: AppContext = {
    startupBootstrap: undefined,
    homey,
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
    getFlowReportedCapabilitiesForDevice: vi.fn(() => ({})),
    getFlowReportedDeviceIds: vi.fn(() => []),
    reportFlowBackedCapability: vi.fn(() => defaultFlowBackedCapabilityReportOutcome),
    getHomeyDevicesForFlow: vi.fn(async () => []),
    emitFlowBackedRefreshRequests: vi.fn(async () => undefined),
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
    getDailyBudgetUiPayload: vi.fn((): DailyBudgetUiPayload | null => null),
    getLatestPlanSnapshotForUi: vi.fn((): DevicePlan | null => null),
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
    get deviceControlProfiles() { return deviceControlProfiles; },
    set deviceControlProfiles(value) { deviceControlProfiles = value; },
    get deviceCommunicationModels() { return deviceCommunicationModels; },
    set deviceCommunicationModels(value) { deviceCommunicationModels = value; },
    get experimentalEvSupportEnabled() { return experimentalEvSupportEnabled; },
    set experimentalEvSupportEnabled(value) { experimentalEvSupportEnabled = value; },
    get shedBehaviors() { return shedBehaviors; },
    set shedBehaviors(value) { shedBehaviors = value; },
    get debugLoggingTopics() { return debugLoggingTopics; },
    set debugLoggingTopics(value) { debugLoggingTopics = value; },
    get defaultComputeDynamicSoftLimit() { return defaultComputeDynamicSoftLimit; },
    set defaultComputeDynamicSoftLimit(value) { defaultComputeDynamicSoftLimit = value; },
    get lastKnownPowerKw() { return {}; },
    get expectedPowerKwOverrides() { return {}; },
    get lastPositiveMeasuredPowerKw() { return {}; },
    get lastNotifiedOperatingMode() { return lastNotifiedOperatingMode; },
    set lastNotifiedOperatingMode(value) { lastNotifiedOperatingMode = value; },
    get powerSampleRebuildState() { return powerSampleRebuildState; },
    set powerSampleRebuildState(value) { powerSampleRebuildState = value; },
    get latestTargetSnapshot() { return latestTargetSnapshot; },
    get priceOptimizationEnabled() { return priceOptimizationEnabled; },
    get priceOptimizationSettings() { return priceOptimizationSettings; },
    capacityGuard: {
      getHeadroom: vi.fn(() => null),
      setLimit: vi.fn(),
      setSoftMargin: vi.fn(),
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
      isCurrentHourCheap: vi.fn(() => false),
      isCurrentHourExpensive: vi.fn(() => false),
    } as never,
    planService: {
      rebuildPlanFromCache: vi.fn(async () => undefined),
      evaluateHeadroomForDevice: vi.fn(() => null),
      syncLivePlanStateInline: vi.fn(() => false),
    } as never,
    snapshotHelpers,
    homeyEnergyHelpers,
    deviceControlHelpers,
    timers,
  };

  Object.assign(context, overrides);
  return context;
}
  const defaultFlowBackedCapabilityReportOutcome: FlowBackedCapabilityReportOutcome = {
    kind: 'state_changed',
    valueChanged: true,
    freshnessAdvanced: true,
    refreshSnapshot: true,
    rebuildPlan: true,
  };
