/* eslint-disable max-lines -- Homey app lifecycle remains centralized in the main app class. */
import Homey from 'homey';
import CapacityGuard from './lib/core/capacityGuard';
import {
  DeviceManager,
  PLAN_LIVE_STATE_OBSERVED_EVENT,
  PLAN_RECONCILE_REALTIME_UPDATE_EVENT,
} from './lib/core/deviceManager';
import { PlanEngine } from './lib/plan/planEngine';
import { DevicePlan, ShedBehavior } from './lib/plan/planTypes';
import { PlanService } from './lib/plan/planService';
import { isPlanActivelyConverging } from './lib/plan/planStateHelpers';
import { buildPlanCapacityStateSummary } from './lib/plan/planLogging';
import { HomeyDeviceLike, TargetDeviceSnapshot, type DeviceTargetPowerConfigs } from './lib/utils/types';
import { PriceCoordinator } from './lib/price/priceCoordinator';
import { PriceFlowTagPublisher } from './lib/price/priceFlowTags';
import { PowerTrackerState } from './lib/core/powerTracker';
import { PriceLevel } from './lib/price/priceLevels';
import { buildPeriodicStatusLogFields } from './lib/core/periodicStatus';
import { getDeviceLoadSetting } from './lib/core/deviceLoad';
import { DailyBudgetService } from './lib/dailyBudget/dailyBudgetService';
import type {
  DeferredObjectiveActivePlanRecorder,
  DeferredObjectivePlanHistoryRecorder,
} from './lib/plan/deferredObjectives';
import type {
  DailyBudgetModelPreviewResponse,
  DailyBudgetSettingsInput,
  DailyBudgetUiPayload,
  DailyBudgetUpdateStateOptions,
} from './lib/dailyBudget/dailyBudgetTypes';
import type { SettingsUiPlanSnapshot } from './packages/contracts/src/settingsUiApi';
import { type DebugLoggingTopic } from './lib/utils/debugLogging';
import {
  AppDeviceControlHelpers,
  normalizeStoredDeviceControlProfiles,
} from './lib/app/appDeviceControlHelpers';
import {
  getAllModes as getAllModesHelper,
  getShedBehavior as getShedBehaviorHelper,
  resolveModeName as resolveModeNameHelper,
} from './lib/utils/capacityHelpers';
import {
  DEVICE_LAST_CONTROLLED_MS,
  FLOW_REPORTED_DEVICE_CAPABILITIES,
  OPERATING_MODE_SETTING,
} from './lib/utils/settingsKeys';
import { isNumberMap, isPowerTrackerState } from './lib/utils/appTypeGuards';
import {
  cancelPendingPowerRebuild,
  executePendingPowerRebuild,
  persistPowerTrackerStateForApp,
  prunePowerTrackerHistoryForApp,
  updateDailyBudgetAndRecordCapForApp,
  PowerSampleRebuildState,
  type PowerTrackerPersistReason,
  recordPowerSampleForApp,
  schedulePlanRebuildFromSignal,
} from './lib/app/appPowerHelpers';
import {
  PowerCalibrationStore,
  createCalibrationSnapshotMutationHook,
  loadPowerCalibrationStore,
  persistPowerCalibrationFlush,
  persistPowerCalibrationIfDue,
} from './lib/app/appPowerCalibrationWiring';
import { shouldSkipShortfallRebuildFromPlanSummary } from './lib/app/appPowerRebuildShortfallSuppression';
import { PlanRebuildScheduler, type RebuildIntent } from './lib/app/planRebuildScheduler';
import {
  createDeferredObjectiveActivePlanRecorder,
  createDeferredObjectivePlanHistoryRecorder,
  createDeviceDiagnosticsService,
  createPlanEngine,
  createPlanService,
  createPriceCoordinator,
  createPriceFlowTagPublisher,
  persistDeferredObjectiveObservationWatermark,
  registerAppFlowCards,
} from './lib/app/appInit';
import type { AppContext, StartupBootstrapConfig } from './lib/app/appContext';
import {
  createDeferredObjectiveEndedBus,
  createDeferredObjectivePlanRevisionBus,
  createDeferredObjectiveStatusBus,
  type DeferredObjectiveEndedBus,
  type DeferredObjectivePlanRevisionBus,
  type DeferredObjectiveStatusBus,
} from './lib/plan/deferredObjectives';
import { buildDebugLoggingTopics } from './lib/app/appLoggingHelpers';
import { initSettingsHandlerForApp, loadCapacitySettingsFromHomey } from './lib/app/appSettingsHelpers';
import {
  disableUnsupportedDevices as disableUnsupportedDevicesHelper,
  seedMissingModeTargets as seedMissingModeTargetsHelper,
  isManagedFilterActive as isManagedFilterActiveHelper,
} from './lib/app/appDeviceSupport';
import { runStartupStep, startAppServices } from './lib/app/appLifecycleHelpers';
import { addPerfDuration, incPerfCounter, incPerfCounters } from './lib/utils/perfCounters';
import { startPerfLogger } from './lib/app/perfLogging';
import { VOLATILE_WRITE_THROTTLE_MS } from './lib/utils/timingConstants';
import { getHourBucketKey } from './lib/utils/dateUtils';
import { startResourceWarningListeners as startResourceWarnings } from './lib/app/appResourceWarningHelpers';
import { installHeapSnapshotHandler } from './lib/app/heapSnapshotHandler';
import { migrateManagedDevices as migrateManagedDevicesHelper } from './lib/app/appManagedDeviceMigration';
import { runBootMigrations as runBootMigrationsHelper } from './lib/app/appBootMigrations';
import { startPriceLowestTriggerChecker as startPriceLowestTriggers } from './lib/app/appPriceLowestTrigger';
import * as realtimeReconcile from './lib/app/appRealtimeDeviceReconcile';
import {
  createRootLogger,
  type Logger as PinoLogger,
  type StructuredDebugEmitter,
} from './lib/logging/logger';
import { createHomeyDestination } from './lib/logging/homeyDestination';
import { normalizeError } from './lib/utils/errorUtils';
import { scheduleAppRealtimeDeviceReconcile } from './lib/app/appRealtimeDeviceReconcileRuntime';
import { logHomeyDeviceComparisonForDebugFromApp } from './lib/app/appDebugHelpers';
import type { ObservedDeviceStateEvent } from './lib/core/deviceManagerRealtimeHandlers';
import {
  emitSettingsUiDevicesUpdatedForApp,
  emitSettingsUiPowerUpdatedForApp,
} from './lib/app/settingsUiAppRuntime';
import type { DeviceDiagnosticsService } from './lib/diagnostics/deviceDiagnosticsService';
import type { SettingsUiDeviceDiagnosticsPayload } from './packages/contracts/src/deviceDiagnosticsTypes';
import type {
  DeferredObjectivePlanHistoryEntry,
} from './packages/contracts/src/deferredObjectivePlanHistory';
import type {
  DeferredObjectiveActivePlansV1,
} from './packages/contracts/src/deferredObjectiveActivePlans';
import type {
  SettingsUiDeferredObjectivePlanHistoryPayload,
} from './packages/contracts/src/settingsUiApi';
import type { DeviceControlProfiles } from './lib/utils/types';
import { AppHomeyEnergyHelpers } from './lib/app/appHomeyEnergyHelpers';
import {
  AppSnapshotHelpers,
  type RefreshTargetDevicesSnapshotOptions,
} from './lib/app/appSnapshotHelpers';
import { TimerRegistry } from './lib/app/timerRegistry';
import {
  getFlowReportedDeviceIds,
  getFlowRefreshRequestedDeviceIds,
  isFlowReportedObservationCapabilityId,
  parseFlowReportedCapabilities,
  upsertFlowReportedCapability,
  type FlowReportedCapabilityId,
  type FlowReportedCapabilitiesByDevice,
  type FlowReportedCapabilitiesForDevice,
} from './lib/core/flowReportedCapabilities';
import {
  EV_SOC_CAPABILITY_ID,
  isStateOfChargeCapabilityId,
  updateStateOfChargeObservationFreshness,
} from './lib/core/deviceStateOfCharge';
import type { FlowBackedCapabilityReportOutcome } from './lib/app/appContext';
const POWER_SAMPLE_REBUILD_MIN_INTERVAL_MS = process.env.NODE_ENV === 'test' ? 0 : 2000;
// Let non-urgent power deltas settle before rebuilding the full plan again.
const POWER_SAMPLE_REBUILD_STABLE_INTERVAL_MS = process.env.NODE_ENV === 'test' ? 0 : 15000;
const POWER_SAMPLE_REBUILD_MAX_INTERVAL_MS = process.env.NODE_ENV === 'test' ? 100 : 30 * 1000;
const FLOW_REBUILD_COOLDOWN_MS = 1000;
const FLOW_DEVICE_AUTOCOMPLETE_CACHE_MS = 15 * 1000;
const STARTUP_RESTORE_STABILIZATION_MS = 60 * 1000;
const POWER_TRACKER_PRUNE_INITIAL_DELAY_MS = 10 * 1000;
const POWER_TRACKER_PRUNE_INTERVAL_MS = 60 * 60 * 1000;
const POWER_TRACKER_PERSIST_DELAY_MS = VOLATILE_WRITE_THROTTLE_MS;
const PLAN_REBUILD_SCHEDULER_DEBUG_RATE_LIMIT_MS = 60 * 1000;
type PriceOptimizationSettings = Record<string, { enabled: boolean; cheapDelta: number; expensiveDelta: number }>;
const getAppPlanRebuildNowMs = (): number => (
  process.env.NODE_ENV === 'test'
  || typeof performance === 'undefined'
  || typeof performance.now !== 'function'
    ? Date.now()
    : performance.now()
);

const shouldForcePersistPowerTracker = (
  previousState: PowerTrackerState,
  nextState: PowerTrackerState,
): boolean => {
  const previousTimestamp = previousState.lastTimestamp;
  const nextTimestamp = nextState.lastTimestamp;
  if (
    typeof previousTimestamp !== 'number'
    || typeof nextTimestamp !== 'number'
    || !Number.isFinite(previousTimestamp)
    || !Number.isFinite(nextTimestamp)
  ) {
    return false;
  }
  return getHourBucketKey(previousTimestamp) !== getHourBucketKey(nextTimestamp);
};

function resolveFlowBackedCapabilityReportOutcome(update: {
  stateChanged: boolean;
  valueChanged: boolean;
  freshnessAdvanced: boolean;
  capabilityId: FlowReportedCapabilityId;
  evSocRebuildPlan?: boolean;
}): FlowBackedCapabilityReportOutcome {
  if (update.stateChanged) {
    return {
      kind: 'state_changed',
      valueChanged: update.valueChanged,
      freshnessAdvanced: update.freshnessAdvanced,
      refreshSnapshot: true,
      rebuildPlan: update.capabilityId === EV_SOC_CAPABILITY_ID
        ? update.evSocRebuildPlan === true
        : true,
    };
  }
  if (update.freshnessAdvanced) {
    return {
      kind: 'freshness_only',
      valueChanged: false,
      freshnessAdvanced: true,
      refreshSnapshot: false,
      rebuildPlan: update.capabilityId === EV_SOC_CAPABILITY_ID && update.evSocRebuildPlan === true,
    };
  }
  return {
    kind: 'noop',
    valueChanged: false,
    freshnessAdvanced: false,
    refreshSnapshot: false,
    rebuildPlan: false,
  };
}

class PelsApp extends Homey.App {
  private powerTracker: PowerTrackerState = {};
  private powerCalibrationStore: PowerCalibrationStore = new PowerCalibrationStore();
  private capacityGuard?: CapacityGuard;
  private readonly deferredObjectiveStatusBus: DeferredObjectiveStatusBus = createDeferredObjectiveStatusBus();
  private readonly deferredObjectivePlanRevisionBus: DeferredObjectivePlanRevisionBus
    = createDeferredObjectivePlanRevisionBus();
  private readonly deferredObjectiveEndedBus: DeferredObjectiveEndedBus
    = createDeferredObjectiveEndedBus();
  private capacitySettings = { limitKw: 10, marginKw: 0.2 };
  private capacityDryRun = true;
  private operatingMode = 'Home';
  private modeAliases: Record<string, string> = {};
  private capacityPriorities: Record<string, Record<string, number>> = {};
  private modeDeviceTargets: Record<string, Record<string, number>> = {};
  private controllableDevices: Record<string, boolean> = {};
  private managedDevices: Record<string, boolean> = {};
  private budgetExemptDevices: Record<string, boolean> = {};
  private temperatureBoostSettings: import('./lib/utils/types').TemperatureBoostSettings = {};
  private evBoostSettings: import('./lib/utils/types').EvBoostSettings = {};
  private nativeEvWiringDevices: Record<string, boolean> = {};
  private deviceDriverOverrides: Record<string, string> = {};
  private flowReportedCapabilities: FlowReportedCapabilitiesByDevice = {};
  private flowBackedCardsAvailable?: boolean;
  private flowDeviceAutocompleteCache?: { devices: HomeyDeviceLike[]; fetchedAtMs: number };
  private flowDeviceAutocompleteRequest?: Promise<HomeyDeviceLike[]>;
  private deviceControlProfiles: DeviceControlProfiles = {};
  private deviceTargetPowerConfigs: DeviceTargetPowerConfigs = {};
  private deviceCommunicationModels: Record<string, 'local' | 'cloud'> = {};
  private shedBehaviors: Record<string, ShedBehavior> = {};
  private debugLoggingTopics = new Set<DebugLoggingTopic>();
  private dailyBudgetService!: DailyBudgetService;
  private deferredObjectivePlanHistoryRecorder?: DeferredObjectivePlanHistoryRecorder;

  private deferredObjectiveActivePlanRecorder?: DeferredObjectiveActivePlanRecorder;
  private deviceDiagnosticsService!: DeviceDiagnosticsService;
  private priceCoordinator!: PriceCoordinator;
  private priceFlowTagPublisher?: PriceFlowTagPublisher;
  private deviceManager!: DeviceManager;
  private planEngine!: PlanEngine;
  private planService!: PlanService;
  private defaultComputeDynamicSoftLimit?: () => number;
  private lastKnownPowerKw: Record<string, number> = {};
  private expectedPowerKwOverrides: Record<string, { kw: number; ts: number }> = {};
  private overheadToken?: Homey.FlowToken;
  private lastPositiveMeasuredPowerKw: Record<string, { kw: number; ts: number }> = {};
  private lastNotifiedOperatingMode = 'Home';
  private powerSampleRebuildState: PowerSampleRebuildState = { lastMs: 0 };
  private readonly planRebuildSchedulerDebugLastEmittedAtMsByKey = new Map<string, number>();
  private readonly planRebuildScheduler = new PlanRebuildScheduler({
    getNowMs: getAppPlanRebuildNowMs,
    resolveDueAtMs: (intent, state) => this.resolvePlanRebuildDueAtMs(intent, state),
    executeIntent: (intent) => this.executePlanRebuildIntent(intent),
    shouldExecuteImmediately: (intent) => intent.kind !== 'flow',
    onIntentDropped: (dropped, kept) => this.onPlanRebuildIntentDropped(dropped, kept),
    onPendingIntentReplaced: (previous, next) => this.onPlanRebuildPendingIntentReplaced(previous, next),
    onIntentCancelled: (intent, reason) => this.onPlanRebuildIntentCancelled(intent, reason),
    onIntentError: (intent, error) => this.onPlanRebuildIntentError(intent, error),
  });
  private powerSampleLoop?: Promise<void>;
  private powerSampleRerunRequested = false;
  private pendingPowerSampleRequest?: { currentPowerW: number; nowMs: number };
  private realtimeDeviceReconcileState = realtimeReconcile.createRealtimeDeviceReconcileState();
  private stopPriceLowestTriggerChecker?: () => void;
  private stopPerfLogging?: () => void;
  private stopResourceWarningListeners?: () => void;
  private stopHeapSnapshotHandler?: () => void;
  private stopSettingsHandler?: () => void;
  private structuredLogger?: PinoLogger;
  private readonly timers = new TimerRegistry();
  private readonly snapshotHelpers = new AppSnapshotHelpers({
    homey: this.homey,
    timers: this.timers,
    getDeviceManager: () => this.deviceManager,
    getPlanEngine: () => this.planEngine,
    getPlanService: () => this.planService,
    getLatestTargetSnapshot: () => this.latestTargetSnapshot,
    resolveManagedState: (deviceId) => this.resolveManagedState(deviceId),
    isCapacityControlEnabled: (deviceId) => this.isCapacityControlEnabled(deviceId),
    getStructuredLogger: (component) => this.getStructuredLogger(component),
    logDebug: (topic, ...args) => this.logDebug(topic, ...args),
    error: (...args) => this.error(...args),
    getNow: () => this.getNow(),
    logPeriodicStatus: (options) => this.logPeriodicStatus(options),
    disableUnsupportedDevices: (snapshot) => disableUnsupportedDevicesHelper({
      snapshot,
      settings: this.homey.settings,
      logDebug: (...args: unknown[]) => this.logDebug('devices', ...args),
    }),
    seedMissingModeTargets: (snapshot) => seedMissingModeTargetsHelper({
      snapshot,
      settings: this.homey.settings,
      structuredLog: (event) => this.getStructuredLogger('devices')?.info(event),
      logDebug: (...args: unknown[]) => this.logDebug('devices', ...args),
    }),
    getFlowReportedDeviceIds: () => this.getFlowReportedDeviceIds(),
    emitFlowBackedRefreshRequests: async (deviceIds) => this.emitFlowBackedRefreshRequests(deviceIds),
    emitSettingsUiDevicesUpdated: () => emitSettingsUiDevicesUpdatedForApp(
      this.homey,
      (message, error) => this.error(message, error),
    ),
    recordPowerSample: async (powerW) => this.recordPowerSample(powerW),
  });
  private readonly homeyEnergyHelpers = new AppHomeyEnergyHelpers({
    homey: this.homey,
    timers: this.timers,
    getDeviceManager: () => this.deviceManager,
    recordPowerSample: async (powerW) => this.recordPowerSample(powerW),
    logDebug: (topic, ...args) => this.logDebug(topic, ...args),
    error: (...args) => this.error(...args),
  });
  private readonly deviceControlHelpers = new AppDeviceControlHelpers({
    getProfiles: () => this.deviceControlProfiles,
    getDeviceSnapshots: () => this.deviceManager?.getSnapshot() ?? [],
    getLatestPlanSnapshot: () => this.planService?.getLatestPlanSnapshot() ?? null,
    getStructuredLogger: (component) => this.getStructuredLogger(component),
    logDebug: (topic, ...args) => this.logDebug(topic, ...args),
  });
  private readonly ctx = this.createAppContext(this);
  private static readonly EXPECTED_OVERRIDE_EQUALS_EPSILON_KW = 0.000001;
  private setExpectedOverride(deviceId: string, kw: number): boolean {
    if (this.deviceControlHelpers.getSteppedLoadProfile(deviceId)) {
      throw new Error(
        'Stepped load devices use configured planning power per step; '
        + 'expected power override is not supported.',
      );
    }
    const existing = this.expectedPowerKwOverrides[deviceId];
    if (typeof existing?.kw === 'number' && Math.abs(existing.kw - kw) <= PelsApp.EXPECTED_OVERRIDE_EQUALS_EPSILON_KW) {
      return false;
    }
    this.expectedPowerKwOverrides[deviceId] = { kw, ts: Date.now() };
    this.planService?.syncHeadroomUsageObservation({
      deviceId,
      usageObservation: { kw },
    });
    return true;
  }

  private loadFlowReportedCapabilities(): void {
    const parsed = parseFlowReportedCapabilities(
      this.homey.settings.get(FLOW_REPORTED_DEVICE_CAPABILITIES) as unknown,
    );
    const filtered = this.filterAvailableFlowReportedCapabilities(parsed);
    this.flowReportedCapabilities = filtered;
    if (JSON.stringify(parsed) === JSON.stringify(filtered)) {
      return;
    }
    this.homey.settings.set(FLOW_REPORTED_DEVICE_CAPABILITIES, filtered);
    this.getStructuredLogger('devices')?.info({
      event: 'flow_backed_state_cleared',
      reasonCode: 'cards_unavailable',
      previousDeviceCount: Object.keys(parsed).length,
      remainingDeviceCount: Object.keys(filtered).length,
    });
  }

  private getFlowReportedCapabilitiesForDevice = (deviceId: string): FlowReportedCapabilitiesForDevice => (
    this.flowReportedCapabilities[deviceId] ?? {}
  );

  private getFlowReportedDeviceIds = (): string[] => (
    getFlowReportedDeviceIds(this.flowReportedCapabilities)
  );

  private reportFlowBackedCapability(params: {
    deviceId: string;
    capabilityId: FlowReportedCapabilityId;
    value: boolean | number | string;
    reportedAt?: number;
  }): FlowBackedCapabilityReportOutcome {
    if (!this.isFlowReportedCapabilityAvailable(params.capabilityId)) {
      return {
        kind: 'noop',
        valueChanged: false,
        freshnessAdvanced: false,
        refreshSnapshot: false,
        rebuildPlan: false,
      };
    }
    const update = upsertFlowReportedCapability({
      state: this.flowReportedCapabilities,
      deviceId: params.deviceId,
      capabilityId: params.capabilityId,
      value: params.value,
      reportedAt: params.reportedAt,
    });
    if (update.stateChanged || (params.capabilityId === EV_SOC_CAPABILITY_ID && update.freshnessAdvanced)) {
      this.homey.settings.set(FLOW_REPORTED_DEVICE_CAPABILITIES, this.flowReportedCapabilities);
    }
    const evSocRebuildPlan = this.shouldRebuildPlanForFlowEvSocReport({
      deviceId: params.deviceId,
      capabilityId: params.capabilityId,
      update,
    });
    if (!update.stateChanged && update.freshnessAdvanced) {
      this.syncFlowBackedObservationFreshness({
        deviceId: params.deviceId,
        capabilityId: params.capabilityId,
        reportedAt: update.entry.reportedAt,
      });
    }
    return resolveFlowBackedCapabilityReportOutcome({
      ...update,
      capabilityId: params.capabilityId,
      evSocRebuildPlan,
    });
  }

  private shouldRebuildPlanForFlowEvSocReport(params: {
    deviceId: string;
    capabilityId: FlowReportedCapabilityId;
    update: {
      valueChanged: boolean;
      freshnessAdvanced: boolean;
      entry: { reportedAt: number };
    };
  }): boolean {
    const { deviceId, capabilityId, update } = params;
    if (capabilityId !== EV_SOC_CAPABILITY_ID) return false;
    const device = this.getSnapshotDevice(deviceId);
    if (!this.hasEnabledEvBoostForSnapshot(device)) return false;
    if (!device?.flowBackedCapabilityIds?.includes(EV_SOC_CAPABILITY_ID)) return false;
    if (update.valueChanged) return true;
    if (!update.freshnessAdvanced) return false;
    return this.canEvSocFreshnessBecomeFreshForBoost(device, update.entry.reportedAt);
  }

  private canEvSocFreshnessBecomeFreshForBoost(
    device: TargetDeviceSnapshot | undefined,
    reportedAt: number,
  ): boolean {
    const stateOfCharge = device?.stateOfCharge;
    if (!device || !stateOfCharge || stateOfCharge.status === 'fresh') return false;
    const nextDevice: TargetDeviceSnapshot = {
      ...device,
      targets: [...device.targets],
      stateOfCharge: { ...stateOfCharge },
    };
    updateStateOfChargeObservationFreshness({
      snapshot: nextDevice,
      reportedAt,
      nowMs: Date.now(),
    });
    return nextDevice.stateOfCharge?.status === 'fresh';
  }

  private syncFlowBackedObservationFreshness(params: {
    deviceId: string;
    capabilityId: FlowReportedCapabilityId;
    reportedAt: number;
  }): void {
    const snapshot = this.deviceManager?.getSnapshot();
    if (!snapshot) return;
    const device = snapshot.find((entry) => entry.id === params.deviceId);
    if (!device || device.flowBacked !== true) return;
    if (!isFlowReportedObservationCapabilityId(params.capabilityId)) {
      return;
    }
    if (params.capabilityId === EV_SOC_CAPABILITY_ID) {
      if (!device.flowBackedCapabilityIds?.includes(params.capabilityId)) return;
      updateStateOfChargeObservationFreshness({
        snapshot: device,
        reportedAt: params.reportedAt,
        nowMs: Date.now(),
      });
      return;
    }
    const nextFreshDataMs = Math.max(device.lastFreshDataMs ?? 0, params.reportedAt);
    if (nextFreshDataMs <= (device.lastFreshDataMs ?? 0)) return;
    device.lastFreshDataMs = nextFreshDataMs;
    device.lastUpdated = nextFreshDataMs;
  }

  private async getHomeyDevicesForFlow(): Promise<HomeyDeviceLike[]> {
    const nowMs = Date.now();
    const cached = this.flowDeviceAutocompleteCache;
    if (cached && nowMs - cached.fetchedAtMs < FLOW_DEVICE_AUTOCOMPLETE_CACHE_MS) {
      return cached.devices;
    }
    if (this.flowDeviceAutocompleteRequest) {
      return this.flowDeviceAutocompleteRequest;
    }
    this.flowDeviceAutocompleteRequest = (async () => {
      const devices = await (this.deviceManager?.getDevicesForDebug() ?? []);
      this.flowDeviceAutocompleteCache = {
        devices: [...devices],
        fetchedAtMs: Date.now(),
      };
      return this.flowDeviceAutocompleteCache.devices;
    })().finally(() => {
      this.flowDeviceAutocompleteRequest = undefined;
    });
    return this.flowDeviceAutocompleteRequest;
  }

  private async emitFlowBackedRefreshRequests(deviceIds: string[]): Promise<void> {
    if (deviceIds.length === 0) return;
    if (!this.areFlowBackedCardsAvailable()) return;
    const card = this.homey.flow?.getTriggerCard?.('flow_backed_device_refresh_requested');
    if (!card?.trigger) return;
    const devices = await this.getHomeyDevicesForFlow();
    const deviceById = new Map(devices.map((device) => [device.id, device]));
    const ignoredNativeEvFlowIds = new Set(
      this.latestTargetSnapshot
        .filter((device) => (
          device.controlAdapter?.kind === 'capability_adapter'
          && !this.flowReportedCapabilities[device.id]?.measure_battery
          && (
            device.controlAdapter.activationEnabled === true
            || (
            device.controlAdapter.activationRequired !== true
            || this.resolveManagedState(device.id) !== true
            )
          )
        ))
        .map((device) => device.id),
    );
    const eligibleDeviceIds = getFlowRefreshRequestedDeviceIds({
      state: this.flowReportedCapabilities,
      devices,
      candidateDeviceIds: deviceIds,
    }).filter((deviceId) => !ignoredNativeEvFlowIds.has(deviceId));
    if (eligibleDeviceIds.length === 0) return;
    const seen = new Set<string>();
    const triggers: Array<{ deviceId: string; trigger: Promise<unknown> }> = [];
    for (const rawDeviceId of eligibleDeviceIds) {
      const deviceId = rawDeviceId.trim();
      if (!deviceId || seen.has(deviceId)) continue;
      seen.add(deviceId);
      const device = deviceById.get(deviceId);
      this.getStructuredLogger('devices')?.info({
        event: 'flow_backed_refresh_requested',
        deviceId,
        deviceName: device?.name,
      });
      triggers.push({
        deviceId,
        trigger: card.trigger({}, { deviceId }),
      });
    }
    if (triggers.length > 0) {
      const results = await Promise.allSettled(triggers.map(({ trigger }) => trigger));
      results.forEach((result, index) => {
        if (result.status === 'fulfilled') return;
        this.getStructuredLogger('devices')?.warn({
          event: 'flow_backed_refresh_request_failed',
          deviceId: triggers[index]?.deviceId,
          err: normalizeError(result.reason),
        });
      });
    }
  }

  // eslint-disable-next-line max-lines-per-function -- Context assembly is intentionally centralized here.
  private createAppContext(app: PelsApp): AppContext {
    const appRef = app;
    return {
      startupBootstrap: undefined,
      homey: app.homey,
      log: (...args: unknown[]) => app.log(...args),
      error: (...args: unknown[]) => app.error(...args),
      logDebug: (topic, ...args) => app.logDebug(topic, ...args),
      getStructuredLogger: (component) => app.getStructuredLogger(component),
      getStructuredDebugEmitter: (component, debugTopic) => app.getStructuredDebugEmitter(component, debugTopic),
      getNow: () => app.getNow(),
      getTimeZone: () => app.getTimeZone(),
      notifyOperatingModeChanged: (mode) => app.notifyOperatingModeChanged(mode),
      loadPowerTracker: (options) => app.loadPowerTracker(options),
      loadCapacitySettings: () => app.loadCapacitySettings(),
      loadPriceOptimizationSettings: () => app.loadPriceOptimizationSettings(),
      updatePriceOptimizationEnabled: (logChange) => app.updatePriceOptimizationEnabled(logChange),
      updateDebugLoggingEnabled: (logChange) => app.updateDebugLoggingEnabled(logChange),
      updateOverheadToken: (value) => app.updateOverheadToken(value),
      registerFlowCards: () => app.registerFlowCards(),
      refreshTargetDevicesSnapshot: (options) => app.refreshTargetDevicesSnapshot(options),
      recordPowerSample: (powerW, nowMs) => app.recordPowerSample(powerW, nowMs),
      startHeartbeat: () => app.startHeartbeat(),
      handleOperatingModeChange: (rawMode) => app.handleOperatingModeChange(rawMode),
      getFlowSnapshot: () => app.getFlowSnapshot(),
      getCurrentPriceLevel: () => app.getCurrentPriceLevel(),
      isCurrentHourCheap: () => app.isCurrentHourCheap(),
      isCurrentHourExpensive: () => app.isCurrentHourExpensive(),
      areFlowBackedCardsAvailable: () => app.areFlowBackedCardsAvailable(),
      getDeviceLoadSetting: (deviceId) => app.getDeviceLoadSetting(deviceId),
      setExpectedOverride: (deviceId, kw) => app.setExpectedOverride(deviceId, kw),
      storeFlowPriceData: (kind, raw) => app.storeFlowPriceData(kind, raw),
      loadDailyBudgetSettings: () => app.dailyBudgetService.loadSettings(),
      updateDailyBudgetState: (options) => app.updateDailyBudgetAndRecordCap(options),
      requestFlowPlanRebuild: (source) => app.planRebuildScheduler.request({
        kind: 'flow',
        reason: `flow_card:${source}`,
      }),
      getFlowReportedCapabilitiesForDevice: (deviceId) => app.getFlowReportedCapabilitiesForDevice(deviceId),
      getFlowReportedDeviceIds: () => app.getFlowReportedDeviceIds(),
      reportFlowBackedCapability: (params) => app.reportFlowBackedCapability(params),
      getHomeyDevicesForFlow: () => app.getHomeyDevicesForFlow(),
      emitFlowBackedRefreshRequests: async (deviceIds) => app.emitFlowBackedRefreshRequests(deviceIds),
      getPriorityForDevice: (deviceId) => app.getPriorityForDevice(deviceId),
      resolveModeName: (name) => app.resolveModeName(name),
      getAllModes: () => app.getAllModes(),
      resolveManagedState: (deviceId) => app.resolveManagedState(deviceId),
      getCommunicationModel: (deviceId) => app.getCommunicationModel(deviceId),
      isCapacityControlEnabled: (deviceId) => app.isCapacityControlEnabled(deviceId),
      isBudgetExempt: (deviceId) => app.isBudgetExempt(deviceId),
      getTemperatureBoostConfig: (deviceId) => app.getTemperatureBoostConfig(deviceId),
      getEvBoostConfig: (deviceId) => app.getEvBoostConfig(deviceId),
      getShedBehavior: (deviceId) => app.getShedBehavior(deviceId),
      computeDynamicSoftLimit: () => app.computeDynamicSoftLimit(),
      getDynamicSoftLimitOverride: () => app.getDynamicSoftLimitOverride(),
      logTargetRetryComparison: async (params) => {
        await logHomeyDeviceComparisonForDebugFromApp({
          app,
          deviceId: params.deviceId,
          reason: `target_retry:${params.skipContext}:${params.targetCap}`,
          expectedTarget: params.desired,
          observedTarget: params.observedValue,
          observedSource: params.observedSource,
        });
      },
      syncLivePlanStateAfterTargetActuation: (source) => app.planService?.syncLivePlanStateInline(source) ?? false,
      evaluateHeadroomForDevice: (params) => app.planService.evaluateHeadroomForDevice(params),
      getCombinedHourlyPrices: () => app.getCombinedHourlyPrices(),
      getDailyBudgetUiPayload: () => app.getDailyBudgetUiPayload(),
      getLatestPlanSnapshotForUi: () => app.getLatestPlanSnapshotForUi(),
      getPowerCalibrationSnapshot: () => app.powerCalibrationStore.getSnapshot(),
      get powerTracker() { return app.powerTracker; },
      set powerTracker(value) { appRef.powerTracker = value; },
      get capacitySettings() { return app.capacitySettings; },
      set capacitySettings(value) { appRef.capacitySettings = value; },
      get capacityDryRun() { return app.capacityDryRun; },
      set capacityDryRun(value) { appRef.capacityDryRun = value; },
      get operatingMode() { return app.operatingMode; },
      set operatingMode(value) { appRef.operatingMode = value; },
      get modeAliases() { return app.modeAliases; },
      set modeAliases(value) { appRef.modeAliases = value; },
      get capacityPriorities() { return app.capacityPriorities; },
      set capacityPriorities(value) { appRef.capacityPriorities = value; },
      get modeDeviceTargets() { return app.modeDeviceTargets; },
      set modeDeviceTargets(value) { appRef.modeDeviceTargets = value; },
      get controllableDevices() { return app.controllableDevices; },
      set controllableDevices(value) { appRef.controllableDevices = value; },
      get managedDevices() { return app.managedDevices; },
      set managedDevices(value) { appRef.managedDevices = value; },
      get budgetExemptDevices() { return app.budgetExemptDevices; },
      set budgetExemptDevices(value) { appRef.budgetExemptDevices = value; },
      get temperatureBoostSettings() { return app.temperatureBoostSettings; },
      set temperatureBoostSettings(value) { appRef.temperatureBoostSettings = value; },
      get evBoostSettings() { return app.evBoostSettings; },
      set evBoostSettings(value) { appRef.evBoostSettings = value; },
      get deviceDriverOverrides() { return app.deviceDriverOverrides; },
      set deviceDriverOverrides(value) { appRef.deviceDriverOverrides = value; },
      get deviceControlProfiles() { return app.deviceControlProfiles; },
      set deviceControlProfiles(value) { appRef.deviceControlProfiles = value; },
      get deviceTargetPowerConfigs() { return app.deviceTargetPowerConfigs; },
      set deviceTargetPowerConfigs(value) { appRef.deviceTargetPowerConfigs = value; },
      get deviceCommunicationModels() { return app.deviceCommunicationModels; },
      set deviceCommunicationModels(value) { appRef.deviceCommunicationModels = value; },
      get shedBehaviors() { return app.shedBehaviors; },
      set shedBehaviors(value) { appRef.shedBehaviors = value; },
      get debugLoggingTopics() { return app.debugLoggingTopics; },
      set debugLoggingTopics(value) { appRef.debugLoggingTopics = value; },
      get defaultComputeDynamicSoftLimit() { return app.defaultComputeDynamicSoftLimit; },
      set defaultComputeDynamicSoftLimit(value) { appRef.defaultComputeDynamicSoftLimit = value; },
      get lastKnownPowerKw() { return app.lastKnownPowerKw; },
      get expectedPowerKwOverrides() { return app.expectedPowerKwOverrides; },
      get lastPositiveMeasuredPowerKw() { return app.lastPositiveMeasuredPowerKw; },
      get lastNotifiedOperatingMode() { return app.lastNotifiedOperatingMode; },
      set lastNotifiedOperatingMode(value) { appRef.lastNotifiedOperatingMode = value; },
      get powerSampleRebuildState() { return app.powerSampleRebuildState; },
      set powerSampleRebuildState(value) { appRef.powerSampleRebuildState = value; },
      get latestTargetSnapshot() { return app.latestTargetSnapshot; },
      getUiPickerDevices: () => app.getUiPickerDevices(),
      get priceOptimizationEnabled() { return app.priceOptimizationEnabled; },
      get priceOptimizationSettings() { return app.priceOptimizationSettings; },
      get capacityGuard() { return app.capacityGuard; },
      set capacityGuard(value) { appRef.capacityGuard = value; },
      get deferredObjectiveStatusBus() { return app.deferredObjectiveStatusBus; },
      get deferredObjectivePlanRevisionBus() { return app.deferredObjectivePlanRevisionBus; },
      get deferredObjectiveEndedBus() { return app.deferredObjectiveEndedBus; },
      get dailyBudgetService() { return app.dailyBudgetService; },
      set dailyBudgetService(value) { appRef.dailyBudgetService = value; },
      get deferredObjectivePlanHistoryRecorder() { return app.deferredObjectivePlanHistoryRecorder; },
      set deferredObjectivePlanHistoryRecorder(value) { appRef.deferredObjectivePlanHistoryRecorder = value; },
      get deferredObjectiveActivePlanRecorder() { return app.deferredObjectiveActivePlanRecorder; },
      set deferredObjectiveActivePlanRecorder(value) { appRef.deferredObjectiveActivePlanRecorder = value; },
      get deviceDiagnosticsService() { return app.deviceDiagnosticsService; },
      set deviceDiagnosticsService(value) { appRef.deviceDiagnosticsService = value; },
      get priceCoordinator() { return app.priceCoordinator; },
      set priceCoordinator(value) { appRef.priceCoordinator = value; },
      get priceFlowTagPublisher() { return app.priceFlowTagPublisher; },
      set priceFlowTagPublisher(value) { appRef.priceFlowTagPublisher = value; },
      get deviceManager() { return app.deviceManager; },
      set deviceManager(value) { appRef.deviceManager = value; },
      get planEngine() { return app.planEngine; },
      set planEngine(value) { appRef.planEngine = value; },
      get planService() { return app.planService; },
      set planService(value) { appRef.planService = value; },
      snapshotHelpers: app.snapshotHelpers,
      homeyEnergyHelpers: app.homeyEnergyHelpers,
      deviceControlHelpers: app.deviceControlHelpers,
      timers: app.timers,
    };
  }

  async onInit() {
    const deferStartupBootstrap = process.env.NODE_ENV !== 'test' || process.env.PELS_ASYNC_STARTUP === '1';
    const logStartupStepFailure = (label: string, error: Error): void => {
      this.structuredLogger?.child({ component: 'startup' }).error({
        event: 'startup_step_failed',
        reasonCode: 'startup_step_failed',
        stepLabel: label,
        err: normalizeError(error),
      });
    };
    this.structuredLogger = createRootLogger(
      createHomeyDestination({ log: (...a) => this.log(...a), error: (...a) => this.error(...a) }),
    );
    this.structuredLogger.child({ component: 'startup' }).info({ event: 'app_initialized' });
    this.startResourceWarningListeners();
    this.stopHeapSnapshotHandler = installHeapSnapshotHandler({
      logger: this.structuredLogger.child({ component: 'heap' }),
    });
    await runStartupStep('updateDebugLoggingEnabled', () => this.updateDebugLoggingEnabled(), logStartupStepFailure);
    this.startPerfLogging();
    await runStartupStep('initPriceCoordinator', () => this.initPriceCoordinator(), logStartupStepFailure);
    await runStartupStep(
      'runStartupSettingsMigrations',
      () => this.runStartupSettingsMigrations(),
      logStartupStepFailure,
    );
    await runStartupStep('loadCapacitySettings', () => this.loadCapacitySettings(), logStartupStepFailure);
    await runStartupStep('initDailyBudgetService', () => this.initDailyBudgetService(), logStartupStepFailure);
    await runStartupStep(
      'loadFlowReportedCapabilities',
      () => this.loadFlowReportedCapabilities(),
      logStartupStepFailure,
    );
    await runStartupStep(
      'initDeviceDiagnosticsService',
      () => this.initDeviceDiagnosticsService(),
      logStartupStepFailure,
    );
    // Load the calibration store before the device manager so the
    // event-driven `onSnapshotMutated` hook is bound to the persisted store
    // from the first observation. Otherwise any live-feed event arriving
    // between `initDeviceManager` and `loadPowerCalibrationStore` would land
    // on the placeholder store and be discarded when the persisted snapshot
    // replaces it.
    await runStartupStep(
      'loadPowerCalibrationStore',
      () => this.loadPowerCalibrationStore(),
      logStartupStepFailure,
    );
    await runStartupStep('initDeviceManager', () => this.initDeviceManager(), logStartupStepFailure);
    let snapshotPlanBootstrapDelayMs = 0;
    if (deferStartupBootstrap) {
      snapshotPlanBootstrapDelayMs = 1200;
    }
    const startupBootstrap: StartupBootstrapConfig = {
      snapshotPlanBootstrapDelayMs,
      runSnapshotPlanBootstrapInBackground: deferStartupBootstrap,
      runPriceBootstrapInBackground: deferStartupBootstrap,
      applyPriceOptimizationImmediatelyOnStart: !deferStartupBootstrap,
    };
    this.ctx.startupBootstrap = startupBootstrap;
    await runStartupStep('initCapacityGuard', () => this.initCapacityGuard(), logStartupStepFailure);
    await runStartupStep('initPlanEngine', () => this.initPlanEngine(), logStartupStepFailure);
    await runStartupStep('initPlanService', () => this.initPlanService(), logStartupStepFailure);
    await runStartupStep('initCapacityGuardProviders', () => this.initCapacityGuardProviders(), logStartupStepFailure);
    await runStartupStep('initSettingsHandler', () => this.initSettingsHandler(), logStartupStepFailure);
    this.lastNotifiedOperatingMode = this.operatingMode;
    await runStartupStep('startAppServices', () => startAppServices(this.ctx), logStartupStepFailure);
    await runStartupStep(
      'startPriceLowestTriggerChecker',
      () => this.startPriceLowestTriggerChecker(),
      logStartupStepFailure,
    );
    await runStartupStep('startPowerTrackerPruning', () => this.startPowerTrackerPruning(), logStartupStepFailure);
  }
  private async initPriceCoordinator(): Promise<void> {
    this.priceCoordinator = createPriceCoordinator(this.ctx);
    const publisher = createPriceFlowTagPublisher(this.ctx);
    this.priceFlowTagPublisher = publisher;
    await publisher.init();
    // Publish whatever the persisted price store already holds, so HomeyScript
    // reads at startup see real data (and the right `unit`) instead of the
    // placeholder default — without waiting for the first price refresh.
    await publisher.publish('startup');
  }
  private initDailyBudgetService(): void {
    this.dailyBudgetService = new DailyBudgetService({
      homey: this.homey,
      log: (...args: unknown[]) => this.log(...args),
      logDebug: (...args: unknown[]) => this.logDebug('daily_budget', ...args),
      isDebugTopicEnabled: (topic) => this.debugLoggingTopics.has(topic),
      error: (...args: unknown[]) => this.error(...args),
      getPowerTracker: () => this.powerTracker,
      getPriceOptimizationEnabled: () => this.priceOptimizationEnabled,
      getCapacitySettings: () => this.capacitySettings,
      requestPriceRefetch: () => this.priceCoordinator?.updateCombinedPrices(),
      structuredLog: this.structuredLogger?.child({ component: 'daily_budget' }),
    });
    this.dailyBudgetService.loadSettings();
    this.dailyBudgetService.loadState();
  }
  private async initDeviceManager(): Promise<void> {
    if (!this.structuredLogger) {
      this.structuredLogger = createRootLogger(
        createHomeyDestination({ log: (...a) => this.log(...a), error: (...a) => this.error(...a) }),
      );
    }
    const structuredLog = this.structuredLogger.child({ component: 'devices' });
    this.deviceManager = new DeviceManager(this, {
      log: this.log.bind(this),
      debug: (...args: unknown[]) => this.logDebug('devices', ...args),
      error: this.error.bind(this),
      structuredLog,
    }, {
      getPriority: (id) => this.getPriorityForDevice(id),
      getControllable: (id) => this.isCapacityControlEnabled(id),
      getManaged: (id) => this.resolveManagedState(id),
      isManagedFilterActive: () => this.isManagedFilterActive(),
      getBudgetExempt: (id) => this.isBudgetExempt(id),
      getCommunicationModel: (id) => this.getCommunicationModel(id),
      getNativeEvWiringEnabled: (id) => this.nativeEvWiringDevices[id] === true,
      getDeviceDriverIdOverride: (id) => this.getDeviceDriverIdOverride(id),
      getDeviceControlProfile: (id) => this.deviceControlProfiles[id],
      getDeviceTargetPowerConfig: (id) => this.deviceTargetPowerConfigs[id],
      getFlowReportedCapabilities: (deviceId) => this.getFlowReportedCapabilitiesForDevice(deviceId),
    }, {
      expectedPowerKwOverrides: this.expectedPowerKwOverrides,
      lastKnownPowerKw: this.lastKnownPowerKw,
      lastPositiveMeasuredPowerKw: this.lastPositiveMeasuredPowerKw,
    }, {
      debugStructured: this.getStructuredDebugEmitter('devices', 'devices'),
      getFlowTriggerCard: (cardId) => this.homey.flow?.getTriggerCard?.(cardId),
      onSnapshotMutated: createCalibrationSnapshotMutationHook({
        getStore: () => this.powerCalibrationStore,
        debugStructured: this.getStructuredDebugEmitter('power_calibration', 'power_calibration'),
      }),
    });
    await this.deviceManager.init();
    this.deviceManager.on(
      PLAN_RECONCILE_REALTIME_UPDATE_EVENT,
      (event: realtimeReconcile.RealtimeDeviceReconcileEvent) => {
        this.scheduleRealtimeDeviceReconcile(event);
      },
    );
    this.deviceManager.on(
      PLAN_LIVE_STATE_OBSERVED_EVENT,
      (event: ObservedDeviceStateEvent) => {
        if (this.shouldRebuildPlanForRealtimeEvSocObservation(event)) {
          incPerfCounters([
            'plan_rebuild_requested_total',
            'plan_rebuild_requested.flow_total',
            'plan_rebuild_requested.flow.realtime_ev_soc_total',
          ]);
          this.planRebuildScheduler.request({
            kind: 'flow',
            reason: 'realtime_ev_soc',
          });
        }
        if (
          event.measurePowerBecameSignificantlyPositive === true
          && this.isCapacityControlEnabled(event.deviceId)
        ) {
          this.powerSampleRebuildState = {
            ...this.powerSampleRebuildState,
            shortfallSuppressionInvalidated: true,
          };
        }
        void this.planService?.syncLivePlanState(event.source);
      },
    );
  }

  private shouldRebuildPlanForRealtimeEvSocObservation(event: ObservedDeviceStateEvent): boolean {
    const capabilityIds = [
      ...(event.capabilityId ? [event.capabilityId] : []),
      ...(event.observedCapabilityIds ?? []),
    ];
    if (!capabilityIds.some((capabilityId) => isStateOfChargeCapabilityId(capabilityId))) return false;
    return this.hasEnabledEvBoostForSnapshot(this.getSnapshotDevice(event.deviceId));
  }

  private getSnapshotDevice(deviceId: string): TargetDeviceSnapshot | undefined {
    return this.deviceManager?.getSnapshot()?.find((entry) => entry.id === deviceId);
  }

  private hasEnabledEvBoostForSnapshot(device: TargetDeviceSnapshot | undefined): boolean {
    if (!device || device.deviceClass !== 'evcharger') return false;
    const config = this.getEvBoostConfig(device.id);
    return config?.enabled === true && Number.isFinite(config.boostBelowPercent);
  }
  private initCapacityGuard(): void {
    this.capacityGuard = new CapacityGuard({
      limitKw: this.capacitySettings.limitKw,
      softMarginKw: this.capacitySettings.marginKw,
      onShortfall: async (deficitKw) => this.planService.handleShortfall(deficitKw),
      onShortfallCleared: async () => this.planService.handleShortfallCleared(),
      structuredLog: this.structuredLogger?.child({ component: 'capacity' }),
      capacityStateSummaryProvider: () => buildPlanCapacityStateSummary(
        this.planService?.getLatestPlanSnapshot(),
        {
          summarySource: 'plan_snapshot',
          summarySourceAtMs: this.planService?.getLatestPlanSnapshotUpdatedAtMs() ?? null,
        },
      ),
    });
  }
  private initPlanEngine(): void {
    if (!this.deferredObjectivePlanHistoryRecorder) {
      this.deferredObjectivePlanHistoryRecorder = createDeferredObjectivePlanHistoryRecorder(this.ctx);
    }
    if (!this.deferredObjectiveActivePlanRecorder) {
      this.deferredObjectiveActivePlanRecorder = createDeferredObjectiveActivePlanRecorder(this.ctx);
    }
    this.planEngine = createPlanEngine(this.ctx);
    this.hydratePlanEngineControlState();
    this.planEngine.beginStartupRestoreStabilization(STARTUP_RESTORE_STABILIZATION_MS);
  }
  private hydratePlanEngineControlState(): void {
    if (!this.planEngine) return;
    const stored = this.homey.settings.get(DEVICE_LAST_CONTROLLED_MS) as unknown;
    this.planEngine.state.lastDeviceControlledMs = isNumberMap(stored) ? { ...stored } : {};
  }
  private initDeviceDiagnosticsService(): void {
    this.deviceDiagnosticsService = createDeviceDiagnosticsService(this.ctx);
  }
  private initPlanService(): void {
    this.planService = createPlanService(this.ctx);
  }
  private getPlanRebuildNowMs(): number {
    return this.planRebuildScheduler.now().nowMs;
  }
  private resolvePlanRebuildDueAtMs(intent: RebuildIntent, state: ReturnType<PlanRebuildScheduler['now']>): number {
    const nowMs = state.nowMs;
    if (intent.kind === 'hardCap') return nowMs;
    if (intent.kind === 'signal') {
      return this.powerSampleRebuildState.pendingDueMs ?? nowMs;
    }
    if (intent.kind === 'flow') {
      if (state.activeIntent?.kind === 'flow') {
        return Number.POSITIVE_INFINITY;
      }
      const lastCompletedAtMs = state.lastCompletedAtMsByKind.flow ?? Number.NEGATIVE_INFINITY;
      return Math.max(nowMs, lastCompletedAtMs + FLOW_REBUILD_COOLDOWN_MS);
    }
    return Number.POSITIVE_INFINITY;
  }
  private executePlanRebuildIntent(intent: RebuildIntent): Promise<void> {
    if (intent.kind === 'signal' || intent.kind === 'hardCap') {
      return executePendingPowerRebuild({
        getState: () => this.powerSampleRebuildState,
        setState: (state) => {
          this.powerSampleRebuildState = state;
        },
        getNowMs: () => this.getPlanRebuildNowMs(),
        rebuildPlanFromCache: (reason?: string) => this.planService.rebuildPlanFromCache(reason),
      });
    }
    return this.planService.rebuildPlanFromCache(intent.reason).then(() => undefined);
  }
  private onPlanRebuildIntentDropped(dropped: RebuildIntent, kept: RebuildIntent): void {
    this.emitRateLimitedPlanRebuildSchedulerDebug(
      `dropped:${dropped.kind}:${dropped.reason}:${kept.kind}:${kept.reason}`,
      {
        event: 'plan_rebuild_scheduler_intent_dropped',
        droppedKind: dropped.kind,
        droppedReason: dropped.reason,
        keptKind: kept.kind,
        keptReason: kept.reason,
      },
    );
  }
  private onPlanRebuildPendingIntentReplaced(previous: RebuildIntent, next: RebuildIntent): void {
    if (previous.kind === 'flow' && next.kind === 'flow') {
      incPerfCounter('plan_rebuild_requested.flow_coalesced_total');
      if (previous.reason !== next.reason) {
        incPerfCounter('plan_rebuild_requested.flow_pending_source_replaced_total');
      }
    }
    this.emitRateLimitedPlanRebuildSchedulerDebug(
      `replaced:${previous.kind}:${previous.reason}:${next.kind}:${next.reason}`,
      {
        event: 'plan_rebuild_scheduler_intent_replaced',
        previousKind: previous.kind,
        previousReason: previous.reason,
        nextKind: next.kind,
        nextReason: next.reason,
      },
    );
  }
  private onPlanRebuildIntentCancelled(intent: RebuildIntent, reason: string): void {
    if (intent.kind === 'signal' || intent.kind === 'hardCap') {
      cancelPendingPowerRebuild({
        getState: () => this.powerSampleRebuildState,
        setState: (state) => {
          this.powerSampleRebuildState = state;
        },
        reason,
      });
    }
  }
  private onPlanRebuildIntentError(intent: RebuildIntent, error: Error): void {
    if (intent.kind === 'flow') {
      this.error(`Flow rebuild scheduler failed for ${intent.reason}`, error);
      return;
    }
    if (intent.kind === 'signal' || intent.kind === 'hardCap') {
      this.error('PowerTracker: Failed to rebuild plan after power sample:', error);
    }
  }
  private emitRateLimitedPlanRebuildSchedulerDebug(key: string, payload: Record<string, unknown>): void {
    if (!this.structuredLogger || !this.debugLoggingTopics.has('plan')) return;
    const nowMs = this.getPlanRebuildNowMs();
    for (const [storedKey, lastEmittedAtMs] of this.planRebuildSchedulerDebugLastEmittedAtMsByKey) {
      if (nowMs - lastEmittedAtMs >= PLAN_REBUILD_SCHEDULER_DEBUG_RATE_LIMIT_MS) {
        this.planRebuildSchedulerDebugLastEmittedAtMsByKey.delete(storedKey);
      }
    }
    const lastEmittedAtMs = this.planRebuildSchedulerDebugLastEmittedAtMsByKey.get(key);
    if (
      typeof lastEmittedAtMs === 'number'
      && nowMs - lastEmittedAtMs < PLAN_REBUILD_SCHEDULER_DEBUG_RATE_LIMIT_MS
    ) {
      return;
    }
    this.planRebuildSchedulerDebugLastEmittedAtMsByKey.set(key, nowMs);
    this.structuredLogger.child({ component: 'plan' }, { level: 'debug' }).debug({
      ...payload,
      debugTopic: 'plan',
    });
  }
  private initCapacityGuardProviders(): void {
    if (!this.capacityGuard) return;
    this.defaultComputeDynamicSoftLimit = this.computeDynamicSoftLimit;
    this.capacityGuard.setSoftLimitProvider(() => this.computeDynamicSoftLimit());
    this.capacityGuard.setShortfallThresholdProvider(() => this.computeShortfallThreshold());
  }
  private initSettingsHandler(): void {
    const settingsHandler = initSettingsHandlerForApp(this.ctx);
    this.stopSettingsHandler = settingsHandler.stop;
  }
  async onUninit(): Promise<void> {
    this.clearUninitTimers();
    realtimeReconcile.clearRealtimeDeviceReconcileState(this.realtimeDeviceReconcileState);
    this.stopUninitServices();
    this.planRebuildScheduler.cancelAll('app_uninit');
    this.deviceDiagnosticsService?.destroy();
    // Persist any unflushed deferred-objective plan-history entries before shutting down.
    this.deferredObjectivePlanHistoryRecorder?.flushIfDirty();
    this.deferredObjectiveActivePlanRecorder?.flushIfDirty();
    this.flushDailyBudgetStateOnUninit();
    // Flush bypasses the debounce window so any samples accepted since the
    // last persist tick reach settings before shutdown. Without this, samples
    // recorded inside the persist-debounce window are lost on restart.
    this.flushPowerCalibration();
    // Mark how far we've observed; back-fill on next startup picks up from here. Skipped if
    // the recorder is still dirty (save failed), so the next start re-scans the missed window.
    persistDeferredObjectiveObservationWatermark(this.ctx, this.deferredObjectivePlanHistoryRecorder);
    this.priceCoordinator.stop();
    this.deviceManager?.destroy();
  }
  private flushDailyBudgetStateOnUninit(): void {
    try {
      this.dailyBudgetService?.persistState('runtime', Date.now());
    } catch (error) {
      this.getStructuredLogger('daily_budget')?.error({
        event: 'daily_budget_state_shutdown_flush_failed',
        err: normalizeError(error),
      });
    }
  }
  private clearUninitTimers(): void {
    if (this.timers.has('powerTrackerSave')) {
      this.persistPowerTrackerState('uninit');
    }
    this.timers.clearAll();
    this.snapshotHelpers.stop();
    this.homeyEnergyHelpers.stop();
  }
  private stopUninitServices(): void {
    this.stopPriceLowestTriggerChecker?.(); this.stopPerfLogging?.();
    this.stopResourceWarningListeners?.(); this.stopHeapSnapshotHandler?.(); this.stopSettingsHandler?.();
  }
  private logDebug(topic: DebugLoggingTopic, ...args: unknown[]): void {
    if (this.debugLoggingTopics.has(topic)) this.log(...args);
  }
  private getStructuredLogger(component: string): PinoLogger | undefined {
    if (!this.structuredLogger) return undefined;
    return this.structuredLogger.child({ component });
  }
  private getStructuredDebugEmitter(component: string, debugTopic: DebugLoggingTopic): StructuredDebugEmitter {
    return (payload) => {
      if (!this.structuredLogger || !this.debugLoggingTopics.has(debugTopic)) return;
      this.structuredLogger.child({ component }, { level: 'debug' }).debug({ ...payload, debugTopic });
    };
  }
  private scheduleRealtimeDeviceReconcile(event: realtimeReconcile.RealtimeDeviceReconcileEvent): void {
    const structuredLog = this.getStructuredLogger('reconcile');
    const debugStructured = this.getStructuredDebugEmitter('reconcile', 'devices');
    const timer = scheduleAppRealtimeDeviceReconcile({
      event,
      state: this.realtimeDeviceReconcileState,
      hasPendingTimer: this.timers.has('realtimeDeviceReconcile'),
      getLatestPlanSnapshot: () => this.planService?.getLatestReconcilePlanSnapshot() ?? null,
      getLiveDevices: () => this.latestTargetSnapshot,
      structuredLog,
      debugStructured,
      reconcile: () => this.planService?.reconcileLatestPlanState() ?? Promise.resolve(false),
      onTimerFired: () => {
        this.timers.clear('realtimeDeviceReconcile');
      },
      onError: (error) => {
        const normalizedError = normalizeError(error);
        structuredLog?.error({
          event: 'realtime_reconcile_failed',
          err: normalizedError,
        });
      },
    });
    if (timer) {
      this.timers.registerTimeout('realtimeDeviceReconcile', timer);
    }
  }
  private startHeartbeat(): void {
    // No-op retained for startup wiring compatibility. The settings UI is only
    // available while the app runtime is alive, so a persistent heartbeat setting
    // only creates write churn without adding useful liveness signal.
  }
  private startPriceLowestTriggerChecker(): void {
    if (this.stopPriceLowestTriggerChecker) this.stopPriceLowestTriggerChecker();
    this.stopPriceLowestTriggerChecker = startPriceLowestTriggers({
      getNow: () => this.getNow(), getTimeZone: () => this.getTimeZone(),
      getCombinedHourlyPrices: () => this.getCombinedHourlyPrices(),
      getTriggerCard: (id) => this.homey.flow.getTriggerCard(id),
      logDebug: (message) => this.logDebug('price', message), error: (message, error) => this.error(message, error),
    });
  }
  private startPerfLogging(): void {
    this.stopPerfLogging = startPerfLogger({
      isEnabled: () => this.debugLoggingTopics.has('perf'), log: (...args: unknown[]) => this.logDebug('perf', ...args),
      logStructured: this.getStructuredDebugEmitter('perf', 'perf'),
      error: (...args: unknown[]) => this.error(...args),
      logCpuSpike: (...args: unknown[]) => this.log(...args), intervalMs: 30 * 1000,
    });
  }
  private startResourceWarningListeners(): void {
    if (this.stopResourceWarningListeners) this.stopResourceWarningListeners();
    this.stopResourceWarningListeners = startResourceWarnings({
      homey: this.homey, log: (message) => this.log(message), error: this.error.bind(this),
    });
  }
  private getDynamicSoftLimitOverride(): number | null {
    if (!this.defaultComputeDynamicSoftLimit || this.computeDynamicSoftLimit === this.defaultComputeDynamicSoftLimit) {
      return null;
    }
    const value = this.computeDynamicSoftLimit();
    return Number.isFinite(value) ? value : null;
  }
  private updatePriceOptimizationEnabled(logChange = false): void {
    this.priceCoordinator.updatePriceOptimizationEnabled(logChange);
  }
  private get priceOptimizationEnabled(): boolean { return this.priceCoordinator.getPriceOptimizationEnabled(); }
  private get priceOptimizationSettings(): PriceOptimizationSettings {
    return this.priceCoordinator.getPriceOptimizationSettings();
  }
  private updateDebugLoggingEnabled(logChange = false): void {
    this.debugLoggingTopics = buildDebugLoggingTopics({
      settings: this.homey.settings,
      log: (...args: unknown[]) => this.log(...args),
      logChange,
    });
  }
  private notifyOperatingModeChanged(mode: string): void {
    const trimmed = mode.trim();
    if (!trimmed || this.lastNotifiedOperatingMode === trimmed) return;
    const card = this.homey.flow?.getTriggerCard?.('operating_mode_changed');
    if (card && typeof card.trigger === 'function') {
      card.trigger({}, { mode: trimmed })
        .catch((err: Error) => this.error('Failed to trigger operating_mode_changed', err));
    }
    this.lastNotifiedOperatingMode = trimmed;
  }
  private loadPowerTracker(options: { skipDailyBudgetUpdate?: boolean } = {}): void {
    // `power_tracker_state` is rewritten every persist tick, so the global
    // settings listener re-runs `loadPowerTracker` continuously at runtime.
    // The calibration store is NOT reloaded here — doing so would discard the
    // in-memory dirty samples that haven't crossed the persist debounce
    // window yet, stalling calibration convergence. The startup load happens
    // exactly once in `onInit` via `loadPowerCalibrationStore`.
    const stored = this.homey.settings.get('power_tracker_state') as unknown;
    if (isPowerTrackerState(stored)) this.powerTracker = stored;
    if (options.skipDailyBudgetUpdate !== true) this.dailyBudgetService.updateState({ refreshObservedStats: false });
  }
  private loadPowerCalibrationStore(): void {
    this.powerCalibrationStore = loadPowerCalibrationStore({ homey: this.homey });
  }
  private persistPowerCalibrationIfDue(nowMs: number = Date.now()): void {
    persistPowerCalibrationIfDue({
      homey: this.homey,
      store: this.powerCalibrationStore,
      nowMs,
      error: (msg, err) => this.error(msg, err),
    });
  }
  private flushPowerCalibration(nowMs: number = Date.now()): void {
    persistPowerCalibrationFlush({
      homey: this.homey,
      store: this.powerCalibrationStore,
      nowMs,
      error: (msg, err) => this.error(msg, err),
    });
  }
  private runStartupSettingsMigrations(): void {
    const log = this.log.bind(this);
    migrateManagedDevicesHelper({ homey: this.homey, log });
    runBootMigrationsHelper({ homey: this.homey, log });
  }
  private areFlowBackedCardsAvailable(): boolean {
    if (typeof this.flowBackedCardsAvailable === 'boolean') {
      return this.flowBackedCardsAvailable;
    }
    this.flowBackedCardsAvailable = this.canAccessFlowCard('action', 'report_flow_backed_device_onoff')
      && this.canAccessFlowCard('trigger', 'flow_backed_device_refresh_requested');
    return this.flowBackedCardsAvailable;
  }
  private canAccessFlowCard(kind: 'action' | 'trigger', cardId: string): boolean {
    try {
      if (kind === 'action') {
        return Boolean(this.homey.flow?.getActionCard?.(cardId));
      }
      return Boolean(this.homey.flow?.getTriggerCard?.(cardId));
    } catch {
      return false;
    }
  }
  private isFlowReportedCapabilityAvailable(capabilityId: FlowReportedCapabilityId): boolean {
    if (capabilityId === EV_SOC_CAPABILITY_ID) {
      return this.canAccessFlowCard('action', 'report_evcharger_battery_level');
    }
    return this.areFlowBackedCardsAvailable();
  }
  private filterAvailableFlowReportedCapabilities(
    state: FlowReportedCapabilitiesByDevice,
  ): FlowReportedCapabilitiesByDevice {
    const next: FlowReportedCapabilitiesByDevice = {};
    for (const [deviceId, entries] of Object.entries(state)) {
      const filteredEntries = Object.fromEntries(
        Object.entries(entries ?? {}).filter(([capabilityId]) => (
          this.isFlowReportedCapabilityAvailable(capabilityId as FlowReportedCapabilityId)
        )),
      ) as FlowReportedCapabilitiesForDevice;
      if (Object.keys(filteredEntries).length > 0) {
        next[deviceId] = filteredEntries;
      }
    }
    return next;
  }
  private loadCapacitySettings(): void {
    const next = loadCapacitySettingsFromHomey({
      settings: this.homey.settings,
      current: {
        capacitySettings: this.capacitySettings,
        modeAliases: this.modeAliases,
        operatingMode: this.operatingMode,
        capacityPriorities: this.capacityPriorities,
        modeDeviceTargets: this.modeDeviceTargets,
        capacityDryRun: this.capacityDryRun,
        controllableDevices: this.controllableDevices,
        managedDevices: this.managedDevices,
        budgetExemptDevices: this.budgetExemptDevices,
        temperatureBoostSettings: this.temperatureBoostSettings,
        evBoostSettings: this.evBoostSettings,
        nativeEvWiringDevices: this.nativeEvWiringDevices,
        deviceDriverOverrides: this.deviceDriverOverrides,
        deviceControlProfiles: this.deviceControlProfiles,
        deviceTargetPowerConfigs: this.deviceTargetPowerConfigs,
        deviceCommunicationModels: this.deviceCommunicationModels,
        shedBehaviors: this.shedBehaviors,
      },
    });
    this.capacitySettings = next.capacitySettings;
    this.modeAliases = next.modeAliases;
    this.operatingMode = next.operatingMode;
    this.capacityPriorities = next.capacityPriorities;
    this.modeDeviceTargets = next.modeDeviceTargets;
    this.capacityDryRun = next.capacityDryRun;
    this.controllableDevices = next.controllableDevices;
    this.managedDevices = next.managedDevices;
    this.budgetExemptDevices = next.budgetExemptDevices;
    this.temperatureBoostSettings = next.temperatureBoostSettings;
    this.evBoostSettings = next.evBoostSettings;
    this.nativeEvWiringDevices = next.nativeEvWiringDevices;
    this.deviceDriverOverrides = next.deviceDriverOverrides;
    this.deviceControlProfiles = normalizeStoredDeviceControlProfiles(next.deviceControlProfiles) ?? {};
    this.deviceTargetPowerConfigs = next.deviceTargetPowerConfigs;
    this.deviceCommunicationModels = next.deviceCommunicationModels;
    this.shedBehaviors = next.shedBehaviors;
    this.updatePriceOptimizationEnabled();
    void this.updateOverheadToken(this.capacitySettings.marginKw);
  }
  private loadPriceOptimizationSettings(): void { this.priceCoordinator.loadPriceOptimizationSettings(); }
  public getDailyBudgetUiPayload(): DailyBudgetUiPayload | null { return this.dailyBudgetService.getUiPayload(); }
  public recomputeDailyBudgetToday(): DailyBudgetUiPayload | null {
    return this.dailyBudgetService.recomputeTodayPlan();
  }
  public previewDailyBudgetModel(settings: DailyBudgetSettingsInput): DailyBudgetModelPreviewResponse {
    return this.dailyBudgetService.previewModelSettings(settings);
  }
  public applyDailyBudgetModel(settings: DailyBudgetSettingsInput): DailyBudgetUiPayload | null {
    return this.dailyBudgetService.applyModelSettings(settings);
  }
  public getLatestPlanSnapshotForUi(): SettingsUiPlanSnapshot | null {
    return this.planService?.getLatestPlanSnapshotForUi() ?? null;
  }
  private async updateOverheadToken(value?: number): Promise<void> {
    const overhead = Number.isFinite(value) ? Number(value) : this.capacitySettings.marginKw;
    try {
      if (!this.overheadToken) {
        this.overheadToken = await this.homey.flow.createToken('capacity_overhead', {
          type: 'number',
          title: 'Soft margin (kW)',
          value: overhead ?? 0,
        });
      }
      await this.overheadToken.setValue(overhead ?? 0);
    } catch (error) {
      this.error('Failed to create/update capacity_overhead token', error as Error);
    }
  }
  private persistPowerTrackerState(reason: PowerTrackerPersistReason = 'write'): void {
    this.timers.clear('powerTrackerSave');
    persistPowerTrackerStateForApp({
      homey: this.homey,
      powerTracker: this.powerTracker,
      reason,
      error: (msg, err) => this.error(msg, err),
    });
  }
  private prunePowerTrackerHistory(): void {
    this.powerTracker = prunePowerTrackerHistoryForApp({
      powerTracker: this.powerTracker,
      logDebug: (msg) => this.logDebug('perf', msg),
      error: (msg, err) => this.error(msg, err),
      // Pass Homey timezone so dailyTotals are keyed by the local calendar day
      // (matches the UI's bucket-derived keys; see TODO `power-tracker-tz-fix`).
      timeZone: this.getTimeZone(),
    });
    this.persistPowerTrackerState('prune');
    // Piggyback on the power-tracker prune tick so the calibration store
    // never grows unbounded across device lifecycles. Flush bypasses the
    // debounce / load-grace gates so the pruned snapshot lands on disk
    // immediately — otherwise a restart inside the persist debounce window
    // would resurrect the pruned device entries from the previous write.
    if (this.powerCalibrationStore.prune(Date.now())) {
      this.flushPowerCalibration(Date.now());
    }
  }
  private startPowerTrackerPruning(): void {
    this.timers.registerTimeout('powerTrackerPruneInitial', setTimeout(() => {
      this.timers.clear('powerTrackerPruneInitial');
      this.prunePowerTrackerHistory();
    }, POWER_TRACKER_PRUNE_INITIAL_DELAY_MS));
    this.timers.registerInterval('powerTrackerPruneInterval', setInterval(
      () => this.prunePowerTrackerHistory(),
      POWER_TRACKER_PRUNE_INTERVAL_MS,
    ));
  }
  private savePowerTracker(nextState: PowerTrackerState): void {
    const stateStart = Date.now();
    const previousState = this.powerTracker;
    this.powerTracker = nextState;
    const forcePersist = shouldForcePersistPowerTracker(previousState, nextState);
    addPerfDuration('power_sample_state_ms', Date.now() - stateStart);

    const budgetStart = Date.now();
    this.updateDailyBudgetAndRecordCap({ nowMs: nextState.lastTimestamp ?? Date.now() });
    addPerfDuration('power_sample_budget_ms', Date.now() - budgetStart);

    if (forcePersist) {
      incPerfCounter('settings_set.power_tracker_state_forced_hour_rollover_total');
      this.persistPowerTrackerState('hour_rollover');
    } else if (!this.timers.has('powerTrackerSave')) {
      incPerfCounter('settings_set.power_tracker_state_scheduled_total');
      this.timers.registerTimeout(
        'powerTrackerSave',
        setTimeout(() => this.persistPowerTrackerState('scheduled'), POWER_TRACKER_PERSIST_DELAY_MS),
      );
    } else {
      incPerfCounter('settings_set.power_tracker_state_skipped_pending_total');
    }

    const uiStart = Date.now();
    emitSettingsUiPowerUpdatedForApp(this.homey, this.powerTracker, (message, error) => this.error(message, error));
    addPerfDuration('power_sample_ui_ms', Date.now() - uiStart);

    this.persistPowerCalibrationIfDue(nextState.lastTimestamp ?? Date.now());
  }
  public replacePowerTrackerForUi(nextState: PowerTrackerState): void {
    this.powerTracker = nextState;
    this.updateDailyBudgetAndRecordCap({
      nowMs: nextState.lastTimestamp ?? Date.now(),
      forcePlanRebuild: true,
      persistReason: 'manual',
    });
    emitSettingsUiPowerUpdatedForApp(this.homey, this.powerTracker, (message, error) => this.error(message, error));
    this.persistPowerTrackerState('ui_replace');
  }
  private updateDailyBudgetAndRecordCap(options?: DailyBudgetUpdateStateOptions): void {
    this.powerTracker = updateDailyBudgetAndRecordCapForApp({
      powerTracker: this.powerTracker,
      dailyBudgetService: this.dailyBudgetService,
      options,
    });
  }
  private async runPowerSample(currentPowerW: number, nowMs: number = Date.now()): Promise<void> {
    const sampleStart = Date.now();
    const previousSampleTs = this.powerTracker.lastTimestamp;
    try {
      const planState = this.planEngine?.state;
      const planConvergenceActive = isPlanActivelyConverging(planState);
      const latestPlanSummary = buildPlanCapacityStateSummary(
        this.planService?.getLatestPlanSnapshot(),
        {
          summarySource: 'plan_snapshot',
          summarySourceAtMs: this.planService?.getLatestPlanSnapshotUpdatedAtMs() ?? null,
        },
      );
      const skipWhileShortfallUnrecoverable = shouldSkipShortfallRebuildFromPlanSummary({
        summary: latestPlanSummary,
        state: this.powerSampleRebuildState,
      });
      await recordPowerSampleForApp({
        currentPowerW,
        nowMs,
        capacitySettings: this.capacitySettings,
        getLatestTargetSnapshot: () => this.latestTargetSnapshot,
        powerTracker: this.powerTracker,
        capacityGuard: this.capacityGuard,
        objectiveProfileDebugStructured: this.getStructuredDebugEmitter('objective_profiles', 'objective_profiles'),
        schedulePlanRebuild: async () => {
          await schedulePlanRebuildFromSignal({
            scheduler: this.planRebuildScheduler,
            getState: () => this.powerSampleRebuildState,
            setState: (state) => {
              this.powerSampleRebuildState = state;
            },
            getNowMs: () => this.getPlanRebuildNowMs(),
            minIntervalMs: POWER_SAMPLE_REBUILD_MIN_INTERVAL_MS,
            stableMinIntervalMs: POWER_SAMPLE_REBUILD_STABLE_INTERVAL_MS,
            maxIntervalMs: POWER_SAMPLE_REBUILD_MAX_INTERVAL_MS,
            rebuildPlanFromCache: (reason?: string) => this.planService.rebuildPlanFromCache(reason),
            currentPowerW,
            capacitySettings: this.capacitySettings,
            capacityGuard: this.capacityGuard,
            planConvergenceActive,
            skipWhileShortfallUnrecoverable,
          });
        },
        saveState: (state) => this.savePowerTracker(state),
      });
      if (previousSampleTs === undefined || nowMs > previousSampleTs) {
        this.planEngine.clearStartupRestoreStabilization(nowMs);
      }
    } finally {
      addPerfDuration('power_sample_ms', Date.now() - sampleStart);
      incPerfCounter('power_sample_total');
    }
  }
  private async recordPowerSample(currentPowerW: number, nowMs: number = Date.now()): Promise<void> {
    incPerfCounter('power_sample_requested_total');
    const request = { currentPowerW, nowMs };

    if (this.powerSampleLoop) {
      if (this.powerSampleRerunRequested) {
        incPerfCounter('power_sample_rerun_coalesced_total');
      } else {
        incPerfCounter('power_sample_rerun_requested_total');
      }
      this.powerSampleRerunRequested = true;
      this.pendingPowerSampleRequest = request;
      return this.powerSampleLoop;
    }

    const loopPromise = this.runCoalescedPowerSamples(request);
    this.powerSampleLoop = loopPromise;
    return loopPromise;
  }
  private async runCoalescedPowerSamples(initialRequest: { currentPowerW: number; nowMs: number }): Promise<void> {
    let request = initialRequest;
    try {
      while (true) {
        this.powerSampleRerunRequested = false;
        this.pendingPowerSampleRequest = undefined;
        await this.runPowerSample(request.currentPowerW, request.nowMs);
        if (!this.powerSampleRerunRequested) return;
        incPerfCounter('power_sample_rerun_executed_total');
        request = this.pendingPowerSampleRequest ?? request;
      }
    } finally {
      if (this.powerSampleLoop) {
        this.powerSampleLoop = undefined;
      }
      this.powerSampleRerunRequested = false;
      this.pendingPowerSampleRequest = undefined;
    }
  }
  private registerFlowCards(): void {
    registerAppFlowCards(this.ctx);
  }
  private async handleOperatingModeChange(rawMode: string): Promise<void> {
    const resolved = resolveModeNameHelper(rawMode, this.modeAliases);
    const previousMode = this.operatingMode;
    if (resolved !== rawMode) this.logDebug('settings', `Mode '${rawMode}' resolved via alias to '${resolved}'`);
    this.operatingMode = resolved;
    this.homey.settings.set(OPERATING_MODE_SETTING, resolved);
    const aliasUsed = rawMode !== resolved ? rawMode : null;
    if (this.homey.settings.get('mode_alias_used') !== aliasUsed) {
      this.homey.settings.set('mode_alias_used', aliasUsed);
    }
    if (previousMode?.toLowerCase() === resolved.toLowerCase()) {
      this.logDebug('settings', `Mode '${resolved}' already active`);
    }
    this.notifyOperatingModeChanged(resolved);
  }
  private async getFlowSnapshot(): Promise<TargetDeviceSnapshot[]> {
    if (!this.latestTargetSnapshot || this.latestTargetSnapshot.length === 0) {
      await this.refreshTargetDevicesSnapshot();
    }
    return this.latestTargetSnapshot;
  }
  private getCurrentPriceLevel(): PriceLevel {
    const status = this.homey.settings.get('pels_status') as { priceLevel?: PriceLevel } | null;
    return (status?.priceLevel || this.planService?.getLastNotifiedPriceLevel() || PriceLevel.UNKNOWN) as PriceLevel;
  }
  private logPeriodicStatus(options: { includeDeviceHealth?: boolean } = {}): void {
    const periodicStatusParams = {
      capacityGuard: this.capacityGuard,
      powerTracker: this.powerTracker,
      capacitySettings: this.capacitySettings,
      operatingMode: this.operatingMode,
      capacityDryRun: this.capacityDryRun,
      starvedDeviceCount: this.deviceDiagnosticsService?.getCurrentStarvedDeviceCount?.() ?? 0,
    };
    this.getStructuredLogger('status')?.info(buildPeriodicStatusLogFields(periodicStatusParams));
    if (options.includeDeviceHealth === true) {
      const deviceStatus = this.deviceManager.getPeriodicStatusMetrics();
      if (deviceStatus) {
        this.getStructuredLogger('devices')?.info({
          event: 'periodic_device_health_summary',
          ...deviceStatus,
        });
      }
    }
    const dailyBudgetStatus = this.dailyBudgetService.getPeriodicStatusFields();
    if (dailyBudgetStatus) {
      this.getStructuredLogger('daily_budget')?.info(dailyBudgetStatus);
    }
  }
  private get latestTargetSnapshot(): TargetDeviceSnapshot[] {
    const snapshot = this.deviceManager?.getSnapshot() ?? [];
    return this.deviceControlHelpers.decorateTargetSnapshotList(snapshot);
  }
  getUiPickerDevices(): TargetDeviceSnapshot[] {
    const snapshot = this.deviceManager?.getUiPickerDevices() ?? [];
    return this.deviceControlHelpers.decorateTargetSnapshotList(snapshot);
  }
  setSnapshotForTests(snapshot: TargetDeviceSnapshot[]): void {
    this.deviceManager.setSnapshotForTests(snapshot);
  }
  parseDevicesForTests(list: HomeyDeviceLike[]): TargetDeviceSnapshot[] {
    return this.deviceManager.parseDeviceListForTests(list);
  }
  private async refreshTargetDevicesSnapshot(
    options: RefreshTargetDevicesSnapshotOptions = {},
  ): Promise<void> {
    await this.snapshotHelpers.refreshTargetDevicesSnapshot(options);
  }
  public getCombinedHourlyPrices = (): unknown => this.priceCoordinator.getCombinedHourlyPrices();
  private getTimeZone = (): string => this.homey.clock.getTimezone();
  private getNow = (): Date => new Date();
  public findCheapestHours = (count: number): string[] => this.priceCoordinator.findCheapestHours(count);
  private isCurrentHourCheap = (): boolean => this.priceCoordinator.isCurrentHourCheap();
  private isCurrentHourExpensive = (): boolean => this.priceCoordinator.isCurrentHourExpensive();
  public getCurrentHourPriceInfo = (): string => this.priceCoordinator.getCurrentHourPriceInfo();
  storeFlowPriceData(kind: 'today' | 'tomorrow', raw: unknown): {
    dateKey: string;
    storedCount: number;
    missingHours: number[];
  } {
    return this.priceCoordinator.storeFlowPriceData(kind, raw);
  }
  public async applyPriceOptimization() {
    return this.priceCoordinator.applyPriceOptimization();
  }
  private async getDeviceLoadSetting(deviceId: string): Promise<number | null> {
    return getDeviceLoadSetting({
      deviceId,
      snapshot: this.latestTargetSnapshot,
      error: (...args: unknown[]) => this.error(...args),
    });
  }
  private getPriorityForDevice = (deviceId: string) => (
    this.capacityPriorities[this.operatingMode || 'Home']?.[deviceId] ?? 100
  );
  private resolveModeName = (name: string) => resolveModeNameHelper(name, this.modeAliases);
  private getAllModes = () => getAllModesHelper(this.operatingMode, this.capacityPriorities, this.modeDeviceTargets);
  private resolveManagedState = (deviceId: string) => this.managedDevices[deviceId] === true;
  private isManagedFilterActive = () => isManagedFilterActiveHelper(this.managedDevices);
  private getCommunicationModel = (deviceId: string): 'local' | 'cloud' => (
    this.deviceCommunicationModels[deviceId] ?? 'local'
  );
  private getDeviceDriverIdOverride = (deviceId: string): string | undefined => {
    const override = this.deviceDriverOverrides[deviceId]?.trim();
    return override || undefined;
  };
  private isCapacityControlEnabled = (deviceId: string) => (
    this.managedDevices[deviceId] === true && this.controllableDevices[deviceId] === true
  );
  private isBudgetExempt = (deviceId: string) => this.budgetExemptDevices[deviceId] === true;
  private getTemperatureBoostConfig = (deviceId: string) => this.temperatureBoostSettings[deviceId];
  private getEvBoostConfig = (deviceId: string) => this.evBoostSettings[deviceId];
  private getShedBehavior = (deviceId: string) => getShedBehaviorHelper(deviceId, this.shedBehaviors);
  private computeDynamicSoftLimit = () => this.planService.computeDynamicSoftLimit();
  private computeShortfallThreshold = () => this.planService.computeShortfallThreshold();
  public getDeviceDiagnosticsUiPayload(): SettingsUiDeviceDiagnosticsPayload {
    return this.deviceDiagnosticsService?.getUiPayload?.()
      ?? { generatedAt: Date.now(), windowDays: 21, diagnosticsByDeviceId: {} };
  }
  public getDeferredObjectiveActivePlansUiPayload(): DeferredObjectiveActivePlansV1 | null {
    return this.deferredObjectiveActivePlanRecorder?.getActivePlansSnapshot() ?? null;
  }
  public getDeferredObjectivePlanHistoryUiPayload(): SettingsUiDeferredObjectivePlanHistoryPayload {
    const snapshot = this.deferredObjectivePlanHistoryRecorder?.getHistorySnapshot();
    const entriesByDeviceId: Record<string, DeferredObjectivePlanHistoryEntry[]> = {};
    if (snapshot) {
      // Sort newest finalizedAtMs first within each device to match the UI expectation.
      const byDevice = new Map<string, DeferredObjectivePlanHistoryEntry[]>();
      for (const entry of snapshot.entries) {
        const list = byDevice.get(entry.deviceId) ?? [];
        list.push(entry);
        byDevice.set(entry.deviceId, list);
      }
      for (const [deviceId, list] of byDevice) {
        entriesByDeviceId[deviceId] = list.sort((a, b) => b.finalizedAtMs - a.finalizedAtMs);
      }
    }
    return { version: 1, entriesByDeviceId };
  }
  public applyPlanActions = (plan: DevicePlan) => this.planService.applyPlanActions(plan);
  public applySheddingToDevice = (deviceId: string, deviceName: string, reason?: string) =>
    this.planService.applySheddingToDevice(deviceId, deviceName, reason);
}

export = PelsApp;
