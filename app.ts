/* eslint-disable max-lines -- Homey app lifecycle remains centralized in the main app class. */
import Homey from 'homey';
import CapacityGuard from './lib/power/capacityGuard';
import { DeviceTransport } from './lib/device/deviceTransport';
import {
  ObservedStateEmitter,
  type ObservedStateChangedEvent,
  type PlanReconcileObservedEvent,
} from './lib/observer/observedStateEvents';
import { ObservedHomePower } from './lib/observer/observedHomePower';
import { ObservedDeviceStateProjection } from './lib/observer/observedDeviceStateProjection';
import { PlanEngine } from './lib/plan/planEngine';
import {
  clearAllPendingBinarySettleWindows,
  clearPendingBinarySettleWindow,
  createBinarySettleState,
  hasPendingBinarySettleWindow,
  notePendingBinarySettleObservation,
  startPendingBinarySettleWindow,
  type BinarySettleState,
} from './lib/observer/binarySettle';
import type { DeviceTransportBinarySettleOps } from './lib/device/deviceTransport';
import { DevicePlan, ShedBehavior } from './lib/plan/planTypes';
import { PlanService } from './lib/plan/planService';
import { SnapshotWarmupGate } from './lib/plan/snapshotWarmupGate';
import { buildPlanCapacityStateSummary } from './lib/plan/planLogging';
import type {
  DecoratedDeviceSnapshot,
  DeviceControlProfiles,
  DeviceTargetPowerConfigs,
  TargetDeviceSnapshot,
} from './packages/contracts/src/types';
import type { HomeyDeviceLike } from './lib/utils/types';
import { PriceCoordinator } from './lib/price/priceCoordinator';
import { PriceFlowTagPublisher } from './lib/price/priceFlowTags';
import { PowerTrackerState } from './lib/power/tracker';
import { PriceLevel } from './lib/price/priceLevels';
import type { CombinedHourlyPrice } from './lib/price/priceTypes';
import { buildPeriodicStatusLogFields } from './lib/diagnostics/periodicStatus';
import { getDeviceLoadSetting } from './lib/device/load';
import type { CommandableNowGraceEntry } from './lib/device/deviceActionProjection';
import { DailyBudgetService } from './lib/dailyBudget/dailyBudgetService';
import type {
  DeferredObjectiveActivePlanRecorder,
  DeferredObjectivePlanHistoryRecorder,
} from './lib/objectives/deferredObjectives';
import type {
  DailyBudgetModelPreviewResponse,
  DailyBudgetSettingsInput,
  DailyBudgetUiPayload,
  DailyBudgetUpdateStateOptions,
} from './lib/dailyBudget/dailyBudgetTypes';
import type { SettingsUiPlanSnapshot } from './packages/contracts/src/settingsUiApi';
import { type DebugLoggingTopic } from './packages/shared-domain/src/utils/debugLogging';
import {
  resolveSmartTaskDeviceKind,
  resolveSmartTaskGoalBounds,
} from './packages/shared-domain/src/smartTaskDeviceKind';
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
  DEFERRED_OBJECTIVE_HOURS_REMAINING_LATCH,
  DEVICE_LAST_CONTROLLED_MS,
  FLOW_REPORTED_DEVICE_CAPABILITIES,
  OPERATING_MODE_SETTING,
} from './lib/utils/settingsKeys';
import { isNumberMap } from './lib/utils/appTypeGuards';
import {
  executePendingPowerRebuild,
  PowerSampleRebuildState,
} from './lib/plan/rebuildScheduler/powerDriven';
import { assembleActivePlansWithTrajectory } from './setup/deferredObjectiveActivePlansUiAssembler';
import { BackgroundTasksController } from './setup/backgroundTasksController';
import { PowerSamplePipeline } from './setup/powerSamplePipeline';
import { SchedulerTelemetryObserver } from './setup/schedulerTelemetryObserver';
import { SettingsRepository } from './setup/settingsRepository';
import { detectNativeWiringConflicts, type NativeWiringConflictDetection } from './setup/flowConflictProbe';
import { getRawFromHomeyApi } from './lib/device/transport/managerHomeyApi';
import {
  persistPowerTrackerStateForApp,
  prunePowerTrackerHistoryForApp,
  updateDailyBudgetAndRecordCapForApp,
  type PowerTrackerPersistReason,
} from './lib/power/sampleIngest';
import {
  PowerCalibrationStore,
  createCalibrationSnapshotMutationHook,
  persistPowerCalibrationFlush,
  persistPowerCalibrationIfDue,
} from './lib/device/devicePowerCalibrationStore';
import { PlanRebuildScheduler, type RebuildIntent } from './lib/plan/rebuildScheduler/scheduler';
import {
  buildDeferredObjectiveDeviceWriteDeps,
  createDeferredObjectiveActivePlanRecorder,
  createDeferredObjectiveLifecycleEmitter,
  createDeferredObjectivePlanHistoryRecorder,
  createDeviceDiagnosticsService,
  createPlanEngine,
  createPlanService,
  createPriceCoordinator,
  createPriceFlowTagPublisher,
  evictMissingDeviceCacheEntries,
  persistDeferredObjectiveObservationWatermark,
  projectPreviewPlanDevice,
  registerAppFlowCards,
  toPlanDevice,
} from './setup/appInit';
import type { AppContext, StartupBootstrapConfig } from './lib/app/appContext';
import {
  createDeferredObjectiveEndedBus,
  createDeferredObjectiveHoursRemainingBus,
  createDeferredObjectiveHoursRemainingTracker,
  createDeferredObjectivePlanRevisionBus,
  createDeferredObjectiveStatusBus,
  migrateBlobToPerKeyIfNeeded,
  normalizeDeferredObjectiveSettingsEntry,
  previewDeferredObjectivePlan,
  readObjectiveForDevice,
  upsertObjectiveForDevice,
  type DeferredObjectiveEndedBus,
  type DeferredObjectiveHoursRemainingBus,
  type DeferredObjectiveHoursRemainingTracker,
  type DeferredObjectivePlanPreviewCandidate,
  type DeferredObjectivePlanRevisionBus,
  type DeferredObjectiveSettingsEntry,
  type DeferredObjectiveStatusBus,
} from './lib/objectives/deferredObjectives';
import { buildDebugLoggingTopics } from './lib/utils/debugLoggingSettings';
import { initSettingsHandlerForApp, loadCapacitySettingsFromHomey } from './lib/app/appSettingsHelpers';
import {
  disableUnsupportedDevices as disableUnsupportedDevicesHelper,
  seedMissingModeTargets as seedMissingModeTargetsHelper,
  isManagedFilterActive as isManagedFilterActiveHelper,
  isRuntimePlannedDevice,
} from './lib/app/appDeviceSupport';
import { runStartupStep, startAppServices } from './lib/app/appLifecycleHelpers';
import { addPerfDuration, incPerfCounter, incPerfCounters } from './lib/utils/perfCounters';
import { VOLATILE_WRITE_THROTTLE_MS } from './lib/utils/timingConstants';
import { getHourBucketKey } from './lib/utils/dateUtils';
import { migrateManagedDevices as migrateManagedDevicesHelper } from './lib/app/appManagedDeviceMigration';
import { runBootMigrations as runBootMigrationsHelper } from './lib/app/appBootMigrations';
import * as realtimeReconcile from './lib/app/appRealtimeDeviceReconcile';
import {
  createRootLogger,
  setRootLogger,
  type Logger as PinoLogger,
  type StructuredDebugEmitter,
} from './lib/logging/logger';
import { createHomeyDestination } from './lib/logging/homeyDestination';
import { normalizeError } from './lib/utils/errorUtils';
import { scheduleAppRealtimeDeviceReconcile } from './lib/app/appRealtimeDeviceReconcileRuntime';
import { logHomeyDeviceComparisonForDebugFromApp } from './lib/app/appDebugHelpers';
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
  DeferredObjectivePlanPreviewEstimate,
} from './packages/contracts/src/deferredObjectivePlanPreview';
import type {
  StarvationRescueDevice,
} from './packages/contracts/src/starvationRescue';
import type {
  SettingsUiDeferredObjectivePlanHistoryPayload,
} from './packages/contracts/src/settingsUiApi';
import { HomeyEnergyPollSource } from './lib/power/sources/homeyEnergyPoll';
import {
  AppSnapshotHelpers,
  type RefreshTargetDevicesSnapshotOptions,
} from './lib/app/appSnapshotHelpers';
import { TimerRegistry } from './lib/app/timerRegistry';
import {
  getFlowReportedDeviceIds,
  getFlowRefreshRequestedDeviceIds,
  isFlowReportedObservationCapabilityId,
  readFlowReportedCapabilitiesForDevice,
  upsertFlowReportedCapability,
  type FlowReportedCapabilityId,
  type FlowReportedCapabilitiesByDevice,
  type FlowReportedCapabilitiesForDevice,
} from './lib/device/transport/flowReportedCapabilities';
import {
  EV_SOC_CAPABILITY_ID,
  isStateOfChargeCapabilityId,
  updateStateOfChargeObservationFreshness,
} from './lib/device/transport/stateOfCharge';
import type { FlowBackedCapabilityReportOutcome } from './lib/app/appContext';
const FLOW_REBUILD_COOLDOWN_MS = 1000;
// Leading window before the first flow rebuild runs, so a burst of settings cards in one
// flow (e.g. set deadline -> allow rescue -> allow rescue) coalesces into a single re-solve
// / one plan revision. 0 in tests so the suite is not delayed.
const FLOW_REBUILD_COALESCE_MS = process.env.NODE_ENV === 'test' ? 0 : 1000;
const FLOW_DEVICE_AUTOCOMPLETE_CACHE_MS = 15 * 1000;
const STARTUP_RESTORE_STABILIZATION_MS = 60 * 1000;
// Bound the warmup wait so a failed/slow Homey Manager fetch can never deadlock
// startup: if `refreshSnapshot()` does not resolve in this window the gate
// releases with reason `timeout` and the planner proceeds (next snapshot will
// arrive on the periodic refresh and rebuild correctly). Tests use a 0 bound
// to skip the wait entirely. Per `feedback_homey_sdk_unreliable`, a slow SDK
// fetch is treated as a transient gap, not a persisted-state corruption.
const SNAPSHOT_WARMUP_TIMEOUT_MS = process.env.NODE_ENV === 'test' ? 0 : 5_000;
const POWER_TRACKER_PRUNE_INITIAL_DELAY_MS = 10 * 1000;
const POWER_TRACKER_PRUNE_INTERVAL_MS = 60 * 60 * 1000;
// Cadence for re-running native-wiring flow-conflict detection so Flows added
// after startup (or a degraded-startup empty snapshot) are picked up without a
// restart. No-op unless the verdict changed.
const NATIVE_WIRING_REQUERY_INTERVAL_MS = 30 * 60 * 1000;
const POWER_TRACKER_PERSIST_DELAY_MS = VOLATILE_WRITE_THROTTLE_MS;
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

// Stable canonical strings for the native-wiring auto-decision + flow-conflict
// maps, so the apply path can detect "no change" regardless of key ordering.
function nativeWiringDecisionKey(decisions: Record<string, boolean>): string {
  return Object.keys(decisions).filter((id) => decisions[id] === true).sort().join('|');
}

function flowConflictKey(
  conflicts: Record<string, { conflictingCapabilities: readonly string[]; flowName?: string }>,
): string {
  return Object.keys(conflicts)
    .sort()
    .map((id) => {
      const conflict = conflicts[id];
      const caps = [...(conflict?.conflictingCapabilities ?? [])].sort().join(',');
      // Include the named Flow so renaming the conflicting Flow re-renders the
      // banner even when the conflicting capability set is unchanged.
      return `${id}:${caps}:${conflict?.flowName ?? ''}`;
    })
    .join('|');
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
  private readonly deferredObjectiveHoursRemainingBus: DeferredObjectiveHoursRemainingBus
    = createDeferredObjectiveHoursRemainingBus();
  // Persist the integer-hour crossing latch via settings so an already-crossed
  // threshold doesn't re-fire after an app restart. A throwing/missing read on
  // cold-start is treated as "no persisted state" — the tracker falls back to
  // first-observation seeding (pre-persistence behaviour). Per
  // `feedback_homey_sdk_unreliable`, never wipe the latch on a single bad read.
  private readonly deferredObjectiveHoursRemainingTracker: DeferredObjectiveHoursRemainingTracker
    = createDeferredObjectiveHoursRemainingTracker({
      load: () => this.homey.settings.get(DEFERRED_OBJECTIVE_HOURS_REMAINING_LATCH),
      save: (latch) => {
        try {
          this.homey.settings.set(DEFERRED_OBJECTIVE_HOURS_REMAINING_LATCH, latch);
        } catch (error) {
          this.error('Failed to persist deferred-objective hours-remaining latch', error);
        }
      },
    });
  private capacitySettings = { limitKw: 10, marginKw: 0.2 };
  private capacityDryRun = true;
  private operatingMode = 'Home';
  private modeAliases: Record<string, string> = {};
  private capacityPriorities: Record<string, Record<string, number>> = {};
  private modeDeviceTargets: Record<string, Record<string, number>> = {};
  private controllableDevices: Record<string, boolean> = {};
  private managedDevices: Record<string, boolean> = {};
  private budgetExemptDevices: Record<string, boolean> = {};
  private temperatureBoostSettings: import('./packages/contracts/src/types').TemperatureBoostSettings = {};
  private evBoostSettings: import('./packages/contracts/src/types').EvBoostSettings = {};
  private nativeEvWiringDevices: Record<string, boolean> = {};
  // Conflict-gated auto-enable decisions for Hoiax native stepped wiring
  // (notes/native-wiring/). In-memory only — recomputed each startup from the
  // flow read + conflict classifier. An explicit user entry in
  // `nativeEvWiringDevices` always takes precedence over this default.
  private autoNativeWiringDecisions: Record<string, boolean> = {};
  // Per-device flow-conflict verdict (the native-write capabilities a user
  // Flow drives), surfaced on the snapshot for the device-detail banner.
  private flowConflictsByDevice: Record<string, { conflictingCapabilities: readonly string[]; flowName?: string }> = {};
  private nativeWiringDecisionInFlight = false;
  // Flipped in onUninit. The native-wiring probe is fire-and-forget and can
  // still be parked on a slow flow read when the app tears down; this flag lets
  // its continuation drop every side effect (logging, snapshot refresh, plan
  // rebuild) instead of acting on a half-torn-down app or logging into a
  // closing worker rpc (the `onUserConsoleLog`-during-teardown error in CI).
  private nativeWiringUninitializing = false;
  private deviceDriverOverrides: Record<string, string> = {};
  private flowReportedCapabilities: FlowReportedCapabilitiesByDevice = {};
  private flowReportedCapabilitiesEmptyParseWarned = false;
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
  private deviceManager!: DeviceTransport;
  /**
   * Observer-owned binarySettle state, constructed by wiring before
   * `DeviceTransport` so the predicate the transport consults at the
   * realtime parse pipeline points at the same store. Per PR #4 of the
   * observer/transport split (notes/state-management/observer-transport-split.md),
   * transport never statically imports observer; the state and the
   * predicate both flow in via DeviceTransport's constructor options.
   */
  private observerBinarySettleState: BinarySettleState = createBinarySettleState();
  /**
   * Observer-owned emitter for post-translation realtime events
   * (`observed-state-changed`, `plan-reconcile-observed`). Wiring builds
   * it during `initDeviceManager`, binds transport's dispatcher to it,
   * and subscribes wiring's own reapply/SoC/perf listeners to it. Per
   * PR #5 of the observer/transport split, transport never statically
   * imports observer; the dispatcher flows in via DeviceTransport's
   * constructor options
   * (notes/state-management/observer-transport-split.md).
   */
  private observedStateEmitter: ObservedStateEmitter = new ObservedStateEmitter();
  // Observer-owned whole-home power scalar (PR2a of the observer/transport
  // split). Transport pushes the Homey-SDK-sourced reading here via the
  // dispatcher; wiring reads it back through `getHomePowerW()`.
  private observedHomePower: ObservedHomePower = new ObservedHomePower();
  // Observer-owned maintained projection of `ObservedDeviceState`, fed by the
  // dispatcher push (per-capability deltas + full-refresh batches). Stage 4a of
  // the snapshot decomposition: stood up + shadow-verified only — NO existing
  // reader is routed through it yet (zero behaviour change). Same lifecycle as
  // the device manager / emitter (recreated together on a transport restart).
  private observedDeviceStateProjection: ObservedDeviceStateProjection = new ObservedDeviceStateProjection();
  private planEngine!: PlanEngine;
  private planService!: PlanService;
  // Created in `onInit` (after the structured logger is wired) and released
  // by `bootstrapSnapshotAndPlan` once the first `refreshSnapshot()`
  // resolves, or by its own bound when the snapshot fetch fails/stalls.
  // Held by `PlanService.rebuildPlanFromCache` so any rebuild triggered
  // between `initDeviceManager` and the first snapshot (price refresh,
  // settings change, realtime device event, flow card) waits for either
  // outcome instead of running the planner against an empty snapshot.
  private snapshotWarmupGate?: SnapshotWarmupGate;
  private defaultComputeDynamicSoftLimit?: () => number;
  private lastKnownPowerKw: Record<string, number> = {};
  private lastKnownCommandableByDevice: Record<string, CommandableNowGraceEntry> = {};
  private expectedPowerKwOverrides: Record<string, { kw: number; ts: number }> = {};
  private overheadToken?: Homey.FlowToken;
  private lastPositiveMeasuredPowerKw: Record<string, { kw: number; ts: number }> = {};
  private lastNotifiedOperatingMode = 'Home';
  private powerSampleRebuildState: PowerSampleRebuildState = { lastMs: 0 };
  private readonly settingsRepository = new SettingsRepository(this.homey);
  private readonly schedulerTelemetry = new SchedulerTelemetryObserver({
    getStructuredLogger: () => this.structuredLogger,
    isDebugTopicEnabled: (topic) => this.debugLoggingTopics.has(topic),
    getNowMs: () => this.getPlanRebuildNowMs(),
    getPowerSampleRebuildState: () => this.powerSampleRebuildState,
    setPowerSampleRebuildState: (state) => {
      this.powerSampleRebuildState = state;
    },
    error: (...args: unknown[]) => this.error(...args),
  });
  private readonly planRebuildScheduler = new PlanRebuildScheduler({
    getNowMs: getAppPlanRebuildNowMs,
    resolveDueAtMs: (intent, state) => this.resolvePlanRebuildDueAtMs(intent, state),
    executeIntent: (intent) => this.executePlanRebuildIntent(intent),
    shouldExecuteImmediately: (intent) => intent.kind !== 'flow',
    onIntentDropped: this.schedulerTelemetry.onIntentDropped,
    onPendingIntentReplaced: this.schedulerTelemetry.onPendingIntentReplaced,
    onIntentCancelled: this.schedulerTelemetry.onIntentCancelled,
    onIntentError: this.schedulerTelemetry.onIntentError,
  });
  private readonly powerSamplePipeline = new PowerSamplePipeline({
    getPowerTracker: () => this.powerTracker,
    getCapacitySettings: () => this.capacitySettings,
    getCapacityGuard: () => this.capacityGuard,
    getPlanEngine: () => this.planEngine,
    getPlanService: () => this.planService,
    getDeviceManager: () => this.deviceManager,
    planRebuildScheduler: this.planRebuildScheduler,
    getPowerSampleRebuildState: () => this.powerSampleRebuildState,
    setPowerSampleRebuildState: (state) => {
      this.powerSampleRebuildState = state;
    },
    getLatestTargetSnapshot: () => this.latestTargetSnapshot,
    getPlanRebuildNowMs: () => this.getPlanRebuildNowMs(),
    savePowerTracker: (state) => this.savePowerTracker(state),
    getStructuredDebugEmitter: (component, topic) => this.getStructuredDebugEmitter(component, topic),
  });
  private realtimeDeviceReconcileState = realtimeReconcile.createRealtimeDeviceReconcileState();
  private stopSettingsHandler?: () => void;
  private readonly backgroundTasks = new BackgroundTasksController({
    homey: this.homey,
    log: (...args: unknown[]) => this.log(...args),
    logDebug: (topic, ...args: unknown[]) => this.logDebug(topic, ...args),
    error: (...args: unknown[]) => this.error(...args),
    isDebugTopicEnabled: (topic) => this.debugLoggingTopics.has(topic),
    getStructuredDebugEmitter: (component, topic) => this.getStructuredDebugEmitter(component, topic),
    getNow: () => this.getNow(),
    getTimeZone: () => this.getTimeZone(),
    getCombinedHourlyPrices: () => this.getCombinedHourlyPrices(),
  });
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
    getStructuredDebugEmitter: (component, topic) => this.getStructuredDebugEmitter(component, topic),
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
    recordPowerSample: async (powerW) => this.powerSamplePipeline.recordPowerSample(powerW),
    // Home power is owned by the observer (PR2a of the observer/transport
    // split); transport pushes the Homey-SDK-sourced scalar there.
    getHomePowerW: () => this.observedHomePower.getHomePowerW(),
  });
  private readonly homeyEnergyHelpers = new HomeyEnergyPollSource({
    homey: this.homey,
    timers: this.timers,
    pollHomePower: async () => (await this.deviceManager?.pollHomePowerW()) ?? null,
    recordPowerSample: async (powerW) => this.powerSamplePipeline.recordPowerSample(powerW),
    logDebug: (topic, ...args) => this.logDebug(topic, ...args),
    error: (...args) => this.error(...args),
  });
  private readonly deviceControlHelpers = new AppDeviceControlHelpers({
    getProfiles: () => this.deviceControlProfiles,
    getDeviceSnapshots: () => this.deviceManager?.getSnapshot() ?? [],
    getLatestPlanSnapshot: () => this.planService?.getLatestPlanSnapshot() ?? null,
    getStructuredLogger: (component) => this.getStructuredLogger(component),
    debugStructured: this.getStructuredDebugEmitter('devices', 'devices'),
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
    const parsed = this.settingsRepository.loadFlowReportedCapabilities();
    // Homey SDK reads can transiently return falsy/empty data even when the
    // underlying setting is intact (see `feedback_homey_sdk_unreliable`). If
    // the parse came back empty but we already hold non-empty in-memory state,
    // treat this as a transient miss and keep the existing map rather than
    // wiping it. The persisted setting is also left untouched, so the next
    // successful read will reconcile from disk.
    if (
      Object.keys(parsed).length === 0
      && Object.keys(this.flowReportedCapabilities).length > 0
    ) {
      if (!this.flowReportedCapabilitiesEmptyParseWarned) {
        this.flowReportedCapabilitiesEmptyParseWarned = true;
        this.getStructuredLogger('devices')?.warn({
          event: 'flow_capabilities_load_empty_parse_keeping_existing',
          inMemoryDeviceCount: Object.keys(this.flowReportedCapabilities).length,
        });
      }
      return;
    }
    const filtered = this.filterAvailableFlowReportedCapabilities(parsed);
    this.flowReportedCapabilities = filtered;
    if (JSON.stringify(parsed) === JSON.stringify(filtered)) {
      return;
    }
    this.settingsRepository.saveFlowReportedCapabilities(filtered);
    this.getStructuredLogger('devices')?.info({
      event: 'flow_backed_state_cleared',
      reasonCode: 'cards_unavailable',
      previousDeviceCount: Object.keys(parsed).length,
      remainingDeviceCount: Object.keys(filtered).length,
    });
  }

  private getFlowReportedCapabilitiesForDevice = (deviceId: string): FlowReportedCapabilitiesForDevice => (
    readFlowReportedCapabilitiesForDevice(this.flowReportedCapabilities, deviceId)
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
      recordPowerSample: (powerW, nowMs) => app.powerSamplePipeline.recordPowerSample(powerW, nowMs),
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
      get lastKnownCommandableByDevice() { return app.lastKnownCommandableByDevice; },
      get expectedPowerKwOverrides() { return app.expectedPowerKwOverrides; },
      get lastPositiveMeasuredPowerKw() { return app.lastPositiveMeasuredPowerKw; },
      get lastNotifiedOperatingMode() { return app.lastNotifiedOperatingMode; },
      set lastNotifiedOperatingMode(value) { appRef.lastNotifiedOperatingMode = value; },
      get powerSampleRebuildState() { return app.powerSampleRebuildState; },
      set powerSampleRebuildState(value) { appRef.powerSampleRebuildState = value; },
      get latestTargetSnapshot() { return app.latestTargetSnapshot; },
      getUiPickerDevices: () => app.getUiPickerDevices(),
      getCreateSmartTaskCandidateDevices: () => app.getCreateSmartTaskCandidateDevices(),
      get priceOptimizationEnabled() { return app.priceOptimizationEnabled; },
      get priceOptimizationSettings() { return app.priceOptimizationSettings; },
      get capacityGuard() { return app.capacityGuard; },
      set capacityGuard(value) { appRef.capacityGuard = value; },
      get deferredObjectiveStatusBus() { return app.deferredObjectiveStatusBus; },
      get deferredObjectivePlanRevisionBus() { return app.deferredObjectivePlanRevisionBus; },
      get deferredObjectiveEndedBus() { return app.deferredObjectiveEndedBus; },
      get deferredObjectiveHoursRemainingBus() { return app.deferredObjectiveHoursRemainingBus; },
      get deferredObjectiveHoursRemainingTracker() { return app.deferredObjectiveHoursRemainingTracker; },
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
      get snapshotWarmupGate() { return app.snapshotWarmupGate; },
      set snapshotWarmupGate(value) { appRef.snapshotWarmupGate = value; },
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
    const structuredLogger = this.installStructuredLogger();
    structuredLogger.child({ component: 'startup' }).info({ event: 'app_initialized' });
    this.backgroundTasks.startResourceWarningListeners();
    this.backgroundTasks.installHeapSnapshotHandler(structuredLogger);
    await runStartupStep('updateDebugLoggingEnabled', () => this.updateDebugLoggingEnabled(), logStartupStepFailure);
    this.backgroundTasks.startPerfLogging();
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
      () => this.backgroundTasks.startPriceLowestTriggerChecker(),
      logStartupStepFailure,
    );
    await runStartupStep(
      'startPostStartupBackgroundTasks',
      () => this.startPostStartupBackgroundTasks(),
      logStartupStepFailure,
    );
  }

  private startPostStartupBackgroundTasks(): void {
    this.startPowerTrackerPruning();
    // Clock-driven smart-task lifecycle emission (status/hours-remaining/ended +
    // history). PlanService exists by now, so the emitter's getDevices reads the
    // live plan-device source. Runs off the power path — fixes the flow-mode lag.
    this.backgroundTasks.startDeferredObjectiveLifecycleClock(
      createDeferredObjectiveLifecycleEmitter(this.ctx),
    );
    // Fire-and-forget native-wiring flow-conflict detection. Best-effort: must
    // never block or fail startup, and reads fail closed. See
    // setup/flowConflictProbe.ts.
    this.runNativeWiringDetectionBestEffort();
    // Re-run periodically so a conflicting Flow added after startup is
    // reflected without a restart, and a degraded startup (empty snapshot at
    // warm-up) recovers once the snapshot populates. The no-change guard makes
    // each run a no-op unless the verdict actually changed; the in-flight guard
    // and a dedicated timer (not the refresh path) keep it from looping.
    this.timers.registerInterval('nativeWiringRequery', setInterval(
      () => this.runNativeWiringDetectionBestEffort(),
      NATIVE_WIRING_REQUERY_INTERVAL_MS,
    ));
  }

  private runNativeWiringDetectionBestEffort(): void {
    if (this.nativeWiringUninitializing) return;
    void this.applyNativeWiringAutoDecisions()
      .catch((error) => {
        // Best-effort: a failed detection/refresh never blocks startup, and
        // the next normal plan cycle re-reads the provider so any applied
        // decision self-heals. Log so prod audits can see the miss — unless we
        // are tearing down, where logging would hit a closing worker rpc.
        if (this.nativeWiringUninitializing) return;
        this.structuredLogger?.child({ component: 'flow_conflict' }).error({
          event: 'flow_conflict_detection_failed',
          err: normalizeError(error),
        });
      });
  }

  private static readonly NATIVE_WIRING_DETECTION_MAX_ATTEMPTS = 3;
  private static readonly NATIVE_WIRING_DETECTION_RETRY_DELAY_MS = 2000;

  // Run detection, retrying while the device snapshot is still empty. The
  // warm-up gate can release via its timeout bound (slow/failed first refresh)
  // with the snapshot not yet populated; treating that empty result as a final
  // "no candidates" would leave conflict-free Hoiax devices native-off until
  // the next restart. A populated snapshot with no candidates is final.
  //
  // An empty snapshot that survives every retry resolves to `unknown`, never an
  // empty `ok` verdict: on a periodic re-query a transient empty snapshot (a
  // refresh/SDK hiccup) would otherwise clear existing auto decisions and turn
  // native control off until the next tick. `unknown` makes it a no-op that
  // keeps prior decisions — and with genuinely zero devices there is nothing to
  // auto-enable, so we lose nothing by not emitting an empty `ok`.
  private async detectNativeWiringConflictsWithSnapshotRetry(): Promise<NativeWiringConflictDetection> {
    for (let attempt = 1; attempt <= PelsApp.NATIVE_WIRING_DETECTION_MAX_ATTEMPTS; attempt += 1) {
      if (this.nativeWiringUninitializing) return { status: 'unknown' };
      const snapshot = this.deviceManager?.getSnapshot() ?? [];
      const lastAttempt = attempt === PelsApp.NATIVE_WIRING_DETECTION_MAX_ATTEMPTS;
      if (snapshot.length === 0) {
        if (!lastAttempt) {
          await this.delayMs(PelsApp.NATIVE_WIRING_DETECTION_RETRY_DELAY_MS);
          continue;
        }
        return { status: 'unknown' };
      }
      return detectNativeWiringConflicts({
        get: (path) => getRawFromHomeyApi(path),
        getSnapshot: () => snapshot,
        // Guarded sink: the flow read can resolve after teardown, so drop the
        // outcome line once uninitializing rather than log into a closing rpc.
        structuredLog: {
          info: (obj) => {
            if (this.nativeWiringUninitializing) return;
            this.structuredLogger?.child({ component: 'flow_conflict' }).info(obj);
          },
        },
      });
    }
    return { status: 'unknown' };
  }

  private delayMs(ms: number): Promise<void> {
    // A detection retry can be pending when the app tears down; resolve at once
    // so the fire-and-forget probe settles promptly instead of holding a timer.
    if (this.nativeWiringUninitializing) return Promise.resolve();
    return new Promise((resolve) => { setTimeout(resolve, ms); });
  }

  // Explicit user choice (true or false in `nativeEvWiringDevices`) always wins;
  // for devices the user has never touched, fall back to the conflict-gated
  // auto-enable decision. See notes/native-wiring/.
  private resolveNativeWiringEnabled(deviceId: string): boolean {
    if (Object.prototype.hasOwnProperty.call(this.nativeEvWiringDevices, deviceId)) {
      return this.nativeEvWiringDevices[deviceId] === true;
    }
    return this.autoNativeWiringDecisions[deviceId] === true;
  }

  // Guarded entry point: startup runs this once and a periodic timer re-runs it
  // (see startPostStartupBackgroundTasks). The in-flight flag keeps overlapping
  // runs — startup vs a periodic tick, or two ticks — from racing.
  private async applyNativeWiringAutoDecisions(): Promise<void> {
    if (this.nativeWiringDecisionInFlight) return;
    this.nativeWiringDecisionInFlight = true;
    try {
      await this.runNativeWiringDecision();
    } finally {
      this.nativeWiringDecisionInFlight = false;
    }
  }

  private async runNativeWiringDecision(): Promise<void> {
    // Wait for the snapshot warm-up gate so detection runs against a populated
    // snapshot rather than the initial empty array — the bootstrap refresh is
    // deferred in production. The gate also releases on its own timeout bound,
    // so this can never hang startup, and the call stays fire-and-forget.
    await this.snapshotWarmupGate?.wait();
    const detection = await this.detectNativeWiringConflictsWithSnapshotRetry();
    // The read above can resolve after teardown began; never refresh the
    // snapshot or rebuild the plan against a half-torn-down app.
    if (this.nativeWiringUninitializing || detection.status !== 'ok') return;

    const nextDecisions: Record<string, boolean> = {};
    for (const deviceId of detection.autoEnableDeviceIds) {
      nextDecisions[deviceId] = true;
    }
    const nextConflicts: Record<string, { conflictingCapabilities: readonly string[]; flowName?: string }> = {};
    for (const conflict of detection.conflicts) {
      nextConflicts[conflict.deviceId] = conflict.flowName === undefined
        ? { conflictingCapabilities: conflict.conflictingCapabilities }
        : { conflictingCapabilities: conflict.conflictingCapabilities, flowName: conflict.flowName };
    }
    if (
      nativeWiringDecisionKey(this.autoNativeWiringDecisions) === nativeWiringDecisionKey(nextDecisions)
      && flowConflictKey(this.flowConflictsByDevice) === flowConflictKey(nextConflicts)
    ) {
      return;
    }

    const previousDecisions = this.autoNativeWiringDecisions;
    const previousConflicts = this.flowConflictsByDevice;
    this.autoNativeWiringDecisions = nextDecisions;
    this.flowConflictsByDevice = nextConflicts;
    try {
      // Re-parse the snapshot (the native-wiring + conflict providers now
      // report the new state) and rebuild the plan so both the decision and
      // the surfaced conflict take effect — mirrors the native-wiring
      // settings-change handler.
      await this.refreshTargetDevicesSnapshot();
      await this.planService?.rebuildPlanFromCache('native_wiring_auto_decision');
    } catch (error) {
      // Keep the apply atomic: if the refresh/rebuild fails, roll both maps
      // back so a later re-query re-attempts cleanly rather than being
      // short-circuited by the no-change guard above.
      this.autoNativeWiringDecisions = previousDecisions;
      this.flowConflictsByDevice = previousConflicts;
      throw error;
    }
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
      debugStructured: this.getStructuredDebugEmitter('daily_budget', 'daily_budget'),
    });
    this.dailyBudgetService.loadSettings();
    this.dailyBudgetService.loadState();
  }
  private installStructuredLogger(): PinoLogger {
    const logger = createRootLogger(
      createHomeyDestination({ log: (...a) => this.log(...a), error: (...a) => this.error(...a) }),
    );
    setRootLogger(logger);
    this.structuredLogger = logger;
    return logger;
  }
  /**
   * Build the observer-owned binarySettle operation bag passed into
   * `DeviceTransport`. Binds each observer function so transport can
   * invoke them through the bag without statically referencing
   * `lib/observer/binarySettle.ts` (cruiser rule
   * `no-device-to-peer-except-power`). PR #4 of the observer/transport
   * split — `notes/state-management/observer-transport-split.md`.
   */
  private buildObserverBinarySettleOps(): DeviceTransportBinarySettleOps {
    return {
      start: startPendingBinarySettleWindow,
      note: notePendingBinarySettleObservation,
      hasWindow: hasPendingBinarySettleWindow,
      clear: clearPendingBinarySettleWindow,
      clearAll: clearAllPendingBinarySettleWindows,
    };
  }

  private async initDeviceManager(): Promise<void> {
    const structuredLogger = this.structuredLogger ?? this.installStructuredLogger();
    const structuredLog = structuredLogger.child({ component: 'devices' });
    this.deviceManager = new DeviceTransport(this, {
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
      getNativeEvWiringEnabled: (id) => this.resolveNativeWiringEnabled(id),
      getFlowConflict: (id) => this.flowConflictsByDevice[id],
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
      binarySettleState: this.observerBinarySettleState,
      binarySettleOps: this.buildObserverBinarySettleOps(),
      pendingPredicate: (deviceId, capabilityId) => (
        hasPendingBinarySettleWindow(this.observerBinarySettleState, deviceId, capabilityId)
      ),
      observedStateDispatcher: this.observedStateEmitter.asDispatcher(this.observedHomePower),
    });
    await this.deviceManager.init();
    // Wiring subscribes to the observer-owned emitter rather than the
    // transport-side EventEmitter. Transport's dispatcher (above) routes
    // every post-translation event through `observedStateEmitter`, which
    // is the single source of truth for realtime fan-out post-PR #5. See
    // notes/state-management/observer-transport-split.md.
    this.observedStateEmitter.onPlanReconcile((event: PlanReconcileObservedEvent) => {
      this.scheduleRealtimeDeviceReconcile(event);
    });
    this.observedStateEmitter.onObservedStateChanged((event: ObservedStateChangedEvent) => {
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
    });
    // Stage 4a: feed the shadow projection from the same emitter as a peer
    // subscriber. The projection only records the decided value transport
    // already merged; no existing reader consumes it yet.
    this.observedStateEmitter.onObservedStateChanged((event) => {
      this.observedDeviceStateProjection.applyDelta(event);
    });
    this.observedStateEmitter.onObservedStateRefresh((event) => {
      this.observedDeviceStateProjection.applyRefresh(event);
    });
  }

  private shouldRebuildPlanForRealtimeEvSocObservation(event: ObservedStateChangedEvent): boolean {
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
    // Create the warmup gate before `initPlanService` reads it via `ctx`.
    // The gate holds the first `rebuildPlanFromCache` (any source) until the
    // bootstrap's first `refreshSnapshot()` resolves, so the planner never
    // runs against an empty snapshot. Without it, a price-refresh or
    // settings-change-triggered rebuild between `initDeviceManager` and the
    // first snapshot publishes `deferred_objective_unknown` for every
    // objective whose device hasn't landed yet, which fires a spurious
    // `waiting → unachievable` flow trigger on every restart.
    this.initSnapshotWarmupGate();
  }
  private hydratePlanEngineControlState(): void {
    if (!this.planEngine) return;
    const stored = this.homey.settings.get(DEVICE_LAST_CONTROLLED_MS) as unknown;
    this.planEngine.state.lastDeviceControlledMs = isNumberMap(stored) ? { ...stored } : {};
  }
  private initDeviceDiagnosticsService(): void {
    this.deviceDiagnosticsService = createDeviceDiagnosticsService(this.ctx);
  }
  private initSnapshotWarmupGate(): void {
    const warmupLogger = this.getStructuredLogger('startup');
    this.snapshotWarmupGate = new SnapshotWarmupGate({
      timeoutMs: SNAPSHOT_WARMUP_TIMEOUT_MS,
      onRelease: (reason) => {
        // Emit at warn for timeout (operationally interesting; means the
        // first device snapshot did not land within the bound) and info for
        // the normal snapshot-ready release. Both go through the structured
        // logger so log audits can attribute spurious-event suppression.
        const payload = {
          event: 'snapshot_warmup_gate_released',
          reason,
          timeoutMs: SNAPSHOT_WARMUP_TIMEOUT_MS,
        };
        if (reason === 'timeout') {
          warmupLogger?.warn(payload);
        } else {
          warmupLogger?.info(payload);
        }
      },
    });
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
      // Leading coalesce window holds the first rebuild a beat so a multi-card flow collapses
      // into one re-solve; the trailing cooldown still throttles subsequent bursts.
      return Math.max(nowMs + FLOW_REBUILD_COALESCE_MS, lastCompletedAtMs + FLOW_REBUILD_COOLDOWN_MS);
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
    // Signal the fire-and-forget native-wiring probe to drop its side effects
    // before anything else tears down. We deliberately do NOT await it: it can
    // be parked on a slow flow read, and blocking teardown on that read would
    // stall shutdown. Suppressing its continuation is enough.
    this.nativeWiringUninitializing = true;
    this.clearUninitTimers();
    realtimeReconcile.clearRealtimeDeviceReconcileState(this.realtimeDeviceReconcileState);
    this.stopUninitServices();
    // Release the warmup gate so any rebuild awaiting it during a partial
    // startup unblocks (cancelAll below then drops the intent), instead of
    // dangling on a promise the gate would otherwise resolve via its
    // bounded timeout.
    this.snapshotWarmupGate?.release('timeout');
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
    this.backgroundTasks.stopAll();
    this.stopSettingsHandler?.();
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
      getLiveDevices: () => {
        const snapshot = this.latestTargetSnapshot;
        evictMissingDeviceCacheEntries(this.ctx, snapshot);
        return snapshot.map((device) => toPlanDevice(this.ctx, device));
      },
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
    const stored = this.settingsRepository.loadPowerTrackerState();
    if (stored) this.powerTracker = stored;
    if (options.skipDailyBudgetUpdate !== true) this.dailyBudgetService.updateState({ refreshObservedStats: false });
  }
  private loadPowerCalibrationStore(): void {
    this.powerCalibrationStore = this.settingsRepository.loadPowerCalibrationStore();
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
        Object.entries(entries).filter(([capabilityId]) => (
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
  private async getFlowSnapshot(): Promise<DecoratedDeviceSnapshot[]> {
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
  private get latestTargetSnapshot(): DecoratedDeviceSnapshot[] {
    const snapshot = this.deviceManager?.getSnapshot() ?? [];
    return this.deviceControlHelpers.decorateTargetSnapshotList(snapshot);
  }
  getUiPickerDevices(): DecoratedDeviceSnapshot[] {
    const snapshot = this.deviceManager?.getUiPickerDevices() ?? [];
    return this.deviceControlHelpers.decorateTargetSnapshotList(snapshot);
  }
  // Devices the create-smart-task widget may OFFER. Sourced from the runtime-
  // planned snapshot AND filtered by the EXACT planned-set predicate the plan
  // service uses (`isRuntimePlannedDevice`, i.e. `managed !== false`). The raw
  // runtime snapshot can still carry `managed: false` devices when the managed
  // filter is inactive (no device explicitly opted-in) — those are dropped by
  // the planner, so offering one would let the widget create a task that never
  // plans or controls anything. `createDeferredObjective` re-applies the same
  // predicate at write time, so listing and validation share one definition.
  getCreateSmartTaskCandidateDevices(): DecoratedDeviceSnapshot[] {
    return this.latestTargetSnapshot.filter(isRuntimePlannedDevice);
  }
  // Currently-starved devices for the starvation-rescue widget. Sourced from the
  // diagnostics service's live starvation state (`getStarvedRescueEntries`,
  // which mirrors the overview `getOverviewStarvation` freshness/eligibility
  // gate) and joined against the runtime-planned snapshot for the device name —
  // a starved device is by definition managed + capacity-controlled, so it is in
  // `latestTargetSnapshot`. The `cause` is the producer-resolved flat value; the
  // widget never re-derives it. Entries whose device is no longer in the snapshot
  // (e.g. removed mid-cycle) are dropped rather than shown with a stale name.
  getStarvedRescueDevices(): StarvationRescueDevice[] {
    const entries = this.deviceDiagnosticsService?.getStarvedRescueEntries?.() ?? [];
    // Index the snapshot by id once (O(N+M)) instead of an O(N×M) `find` per
    // entry — the live snapshot can be sizeable on busy installs.
    const snapshotById = new Map<string, TargetDeviceSnapshot>(
      this.latestTargetSnapshot.map((device) => [device.id, device]),
    );
    const devices: StarvationRescueDevice[] = [];
    for (const entry of entries) {
      const device = snapshotById.get(entry.deviceId);
      if (!device) continue;
      devices.push({
        deviceId: entry.deviceId,
        deviceName: device.name,
        cause: entry.starvation.cause,
        accumulatedMs: entry.starvation.accumulatedMs,
        intendedNormalTargetC: entry.intendedNormalTargetC,
        // A device with an open smart task stays VISIBLE in the held-back list
        // but is not rescuable (the widget suppresses its button): the rescue is
        // a fresh one-shot task and must never replace the device's own active
        // or paused future task. A disabled task whose deadline is already in the
        // past no longer blocks rescue; it is history, not an open task.
        hasSmartTask: this.hasDeferredObjectiveForDevice(entry.deviceId),
      });
    }
    return devices;
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
  public getCombinedHourlyPrices = (): CombinedHourlyPrice[] => this.priceCoordinator.getCombinedHourlyPrices();
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
    const snapshot = this.deferredObjectiveActivePlanRecorder?.getActivePlansSnapshot() ?? null;
    if (snapshot === null) return null;
    // Stitch live in-progress trajectory (start progress + observed samples)
    // onto the snapshot for the smart-tasks widget chart. UI-only — never
    // persisted (see the assembler + the field doc on the contract).
    return assembleActivePlansWithTrajectory(snapshot, this.deferredObjectivePlanHistoryRecorder);
  }
  // Read the device's currently-persisted deferred objective, or undefined when
  // none is stored. Backs `hasDeferredObjectiveForDevice`.
  private readDeferredObjectiveEntry(deviceId: string): DeferredObjectiveSettingsEntry | undefined {
    return readObjectiveForDevice(this.homey.settings, deviceId);
  }
  // Whether the device currently has an open deferred objective (a smart task).
  // Enabled entries always count; disabled future entries also count because the
  // user has paused a still-open task. Disabled past entries do not count — they
  // are completed/abandoned history and must not suppress a fresh held-back
  // rescue forever.
  public hasDeferredObjectiveForDevice(deviceId: string): boolean {
    const entry = this.readDeferredObjectiveEntry(deviceId);
    if (!entry) return false;
    return entry.enabled || entry.deadlineAtMs > this.getNow().getTime();
  }
  // Only stepped-load devices (EV chargers + stepped thermal) can honour the
  // `limitLowerPriorityDevices` rescue permission — it engages the device's boost,
  // which the boost resolvers gate on `isSteppedLoad`; a binary on/off device has
  // no higher step to promote to. The rescue gates the grant on this so it never
  // persists (nor surfaces) a permission the device can't use.
  private deviceSupportsLimitLowerPriority(device: TargetDeviceSnapshot): boolean {
    return device.controlModel === 'stepped_load' && device.steppedLoadProfile?.model === 'stepped_load';
  }
  // Gate a create-smart-task candidate's opt-in "Extra permissions" against the
  // device BEFORE it is previewed or persisted — defence-in-depth, since the
  // widget's toggle visibility is client-side and not trusted. Only
  // `limitLowerPriorityDevices` is gated; `exemptFromBudget` is ungated (any
  // device can exceed the soft daily budget). The limit grant is dropped unless
  // it would ACTUALLY change the plan — i.e. it matches every conjunct of the
  // planner's `fullyReserved` floor (`rescueReplan.ts`): the device is
  // stepped-load eligible (a binary device has no higher step to promote to) AND
  // at top priority (`priority === 1`) AND `exemptFromBudget` is granted as
  // `'always'`. Anything weaker is inert at the planner, so we never persist it.
  // This matches the widget's gate-on-effect visibility exactly, and runs on BOTH
  // lanes so preview ≡ persist. Returns the candidate unchanged when it carries
  // no limit-lower-priority grant.
  private gateCandidateExtraPermissions(
    device: TargetDeviceSnapshot | undefined,
    candidate: DeferredObjectivePlanPreviewCandidate,
  ): DeferredObjectivePlanPreviewCandidate {
    const rescue = candidate.rescue;
    if (!rescue?.limitLowerPriorityDevices) return candidate;
    const eligible = device !== undefined
      && this.deviceSupportsLimitLowerPriority(device)
      && device.priority === 1
      && rescue.exemptFromBudget === 'always';
    if (eligible) return candidate;
    const { limitLowerPriorityDevices: _dropped, ...keptRescue } = rescue;
    return {
      ...candidate,
      rescue: Object.keys(keptRescue).length > 0 ? keptRescue : undefined,
    };
  }
  // Preview the plan the starvation rescue would actually persist. A rescue only
  // ever runs on a device WITHOUT an existing smart task (`getStarvedRescueDevices`
  // excludes task-having devices), so there is no merge: the fresh candidate IS
  // what persists. This therefore just REUSES the create engine's preview
  // (`previewDeferredObjectivePlan`), which applies the same
  // `gateCandidateExtraPermissions` the create write does — so preview ≡ persist
  // for the rescue's opt-in permissions without any rescue-specific merge logic.
  // `hasExistingObjective` is always false (kept on the return for the widget's
  // stable shape).
  public previewStarvationRescuePlan(
    deviceId: string,
    freshRescueCandidate: DeferredObjectivePlanPreviewCandidate,
  ): { estimate: DeferredObjectivePlanPreviewEstimate; deadlineAtMs: number; hasExistingObjective: boolean } {
    return {
      estimate: this.previewDeferredObjectivePlan(deviceId, freshRescueCandidate),
      deadlineAtMs: freshRescueCandidate.deadlineAtMs,
      hasExistingObjective: false,
    };
  }
  // Instant, in-isolation estimate of the plan the planner WOULD produce for a
  // candidate deferred objective that is not persisted. Gathers the same plan-
  // cycle context the live recorder runs against (device snapshot, power
  // tracker, daily-budget snapshot, hard cap, prices) so the projection stays
  // faithful — see `previewDeferredObjectivePlan`.
  //
  // STRICTLY READ-ONLY: this never mutates live planner state. The candidate
  // device is projected through `projectPreviewPlanDevice`, which runs
  // `toPlanDevice` against a preview-scoped context whose commandable
  // grace-window record is a throwaway shallow copy, so the projection's
  // `recordCommandableObservation` write cannot re-anchor the live
  // abandon-grace timestamps.
  //
  // NOT A GUARANTEE — and specifically OPTIMISTIC about headroom: the
  // projection assumes the candidate has the price bucket's reserved headroom
  // to ITSELF (it passes `activePlans: null` and lets `concurrentEligibleCount`
  // default to 1). When other reserved sibling tasks are competing for the same
  // buckets, the live plan may schedule fewer or later hours than this estimate
  // shows, so the divergence is toward overstating availability / understating
  // `cannot_meet` risk. A UI must present this as an estimate, never a
  // commitment.
  public previewDeferredObjectivePlan(
    deviceId: string,
    candidate: DeferredObjectivePlanPreviewCandidate,
  ): DeferredObjectivePlanPreviewEstimate {
    // The settings-UI device list spans managed devices AND unmanaged-but-
    // eligible picker devices (see `getSettingsUiDevices`). A preview is most
    // useful precisely for a candidate that is not managed yet, so fall back to
    // the picker snapshot before treating the device as missing — otherwise
    // every new-smart-task preview would come back `unavailable`.
    const snapshotDevice = this.latestTargetSnapshot.find((device) => device.id === deviceId)
      ?? this.getUiPickerDevices().find((device) => device.id === deviceId);
    // Gate opt-in extra permissions the same way the create lane does, so the
    // preview reflects exactly what would persist (preview ≡ persist).
    const gatedCandidate = this.gateCandidateExtraPermissions(snapshotDevice, candidate);
    return previewDeferredObjectivePlan({
      nowMs: this.getNow().getTime(),
      timeZone: this.getTimeZone(),
      deviceId,
      candidate: gatedCandidate,
      // Convert through the same `toPlanDevice` producer the plan cycle uses so
      // the projected steps/power match the live planner — but via
      // `projectPreviewPlanDevice`, which isolates the producer's grace-window
      // write onto a throwaway copy so the preview stays read-only. Undefined
      // when the device is in neither snapshot → projection comes back
      // `unavailable`.
      device: snapshotDevice ? projectPreviewPlanDevice(this.ctx, snapshotDevice) : undefined,
      powerTracker: this.powerTracker,
      dailyBudgetSnapshot: this.dailyBudgetService?.getSnapshot() ?? null,
      priceOptimizationEnabled: this.priceOptimizationEnabled,
      hardCapKw: this.capacitySettings.limitKw,
      // The price store exposes a per-kWh RATE label; `previewDeferredObjectivePlan`
      // converts it to a money unit for the total `costEstimate`.
      priceRateLabel: this.priceCoordinator.getPriceUnitLabel(),
    });
  }
  // Persist a new smart task (deferred objective) for an eligible device,
  // routing through the SAME device-scoped write op the deadline Flow cards use
  // (`upsertObjectiveForDevice` over the per-device-key store, built by
  // `buildDeferredObjectiveDeviceWriteDeps`). There is no parallel
  // persistence path: the candidate is validated through the same
  // `normalizeDeferredObjectiveSettingsEntry` normalizer that gates Flow-card
  // and settings writes, and the device's eligibility/kind is checked against
  // the live snapshot the same way the Flow cards check it.
  //
  // PLANNED-SET HONESTY: persistence is restricted to devices in
  // `latestTargetSnapshot` — the managed, runtime-planned set. The planner only
  // evaluates objectives whose device is in that snapshot (see
  // `buildDeferredObjectiveDiagnostics`: a missing device yields
  // `objective_missing_device` and is never planned). When the managed-device
  // filter is active, a picker-only (unmanaged) device is absent from the
  // snapshot, so creating a task on it would persist a task that never plans or
  // controls anything. The Flow-card create path is already honest here — its
  // device autocomplete is sourced from the same runtime snapshot — so to match
  // it we reject picker-only devices with `device_not_planned` rather than
  // inventing a promotion mechanism neither path has. (The preview at
  // `previewDeferredObjectivePlan` keeps its picker fallback: previewing an
  // unmanaged device is harmless and read-only.)
  //
  // The candidate's `deadlineAtMs` is resolved by the caller (the widget API
  // handler, server-side, via `resolveDeferredObjectiveDeadline` against the
  // app timezone) so this method stays timezone-agnostic and matches the
  // Flow-card contract of receiving an already-absolute deadline.
  //
  // Returns `{ ok: false }` with a stable reason code on rejection so the
  // widget can surface an honest error without leaking internal detail.
  // Shared validation for both objective-write lanes (`createDeferredObjective`
  // and `rescueDeviceWithBudgetExemption`): resolve the candidate against the
  // runtime-planned snapshot, the device's goal kind, and the device's actual
  // setpoint range, then normalise it through the canonical normalizer. Returns
  // the validated device + normalised entry, or a stable rejection reason. Both
  // callers share this so the device honesty / kind / bounds / normalizer gates
  // never diverge between the two lanes.
  private resolveValidatedObjectiveEntry(
    deviceId: string,
    candidate: DeferredObjectivePlanPreviewCandidate,
  ): { ok: true; device: TargetDeviceSnapshot; entry: DeferredObjectiveSettingsEntry } | {
    ok: false;
    reason: 'device_not_found' | 'device_not_planned' | 'device_not_eligible' | 'invalid_candidate';
  } {
    // Persist ONLY against the runtime-planned snapshot — see PLANNED-SET
    // HONESTY above. A device that exists in the picker but not here, OR that is
    // in the runtime snapshot but `managed: false` (so the planner's
    // `isRuntimePlannedDevice` filter drops it — possible when the managed
    // filter is inactive), is reported as `device_not_planned`, not silently
    // persisted. Uses the SAME predicate the plan service and the candidate
    // listing use so the three never diverge.
    const device = this.latestTargetSnapshot.find((entry) => entry.id === deviceId);
    if (!device || !isRuntimePlannedDevice(device)) {
      const inPickerOrSnapshot = device !== undefined
        || this.getUiPickerDevices().some((entry) => entry.id === deviceId);
      return { ok: false, reason: inPickerOrSnapshot ? 'device_not_planned' : 'device_not_found' };
    }
    // The device must support the goal kind the candidate claims — an EV-SoC
    // goal on a thermostat (or vice versa) is rejected before it can persist.
    const kind = resolveSmartTaskDeviceKind(device);
    if (kind !== candidate.kind) {
      return { ok: false, reason: 'device_not_eligible' };
    }
    // Validate the target against the DEVICE's actual setpoint range, not just
    // the generic normalizer's -50..100 °C / 1..100 % envelope. This mirrors the
    // Flow-card `validateTargetTemperature` (which reads the device capability
    // min/max) and the picker bounds the widget itself offered, so the write
    // rejects an impossible target (e.g. 90 °C on a 30..75 °C heater) instead of
    // persisting one the device can never reach.
    const bounds = resolveSmartTaskGoalBounds(device, kind);
    const targetValue = candidate.kind === 'temperature' ? candidate.targetTemperatureC : candidate.targetPercent;
    if (!Number.isFinite(targetValue) || targetValue < bounds.min || targetValue > bounds.max) {
      return { ok: false, reason: 'invalid_candidate' };
    }
    // Gate opt-in extra permissions against the resolved device before the entry
    // is normalised/persisted (drops an ineligible/inert limit-lower-priority
    // grant), so a tampered or stale client can never persist a permission this
    // device can't honour. Matches the gate the preview applies.
    const gatedCandidate = this.gateCandidateExtraPermissions(device, candidate);
    // Re-validate via the canonical normalizer with `enabled: true`; a creation
    // is implicitly an enabled objective. This rejects malformed deadlines and
    // the generic target envelope exactly as the Flow-card / settings paths do.
    const entry = normalizeDeferredObjectiveSettingsEntry(
      { ...gatedCandidate, enabled: true } as DeferredObjectiveSettingsEntry,
    );
    if (!entry) return { ok: false, reason: 'invalid_candidate' };
    return { ok: true, device, entry };
  }
  public createDeferredObjective(
    deviceId: string,
    candidate: DeferredObjectivePlanPreviewCandidate,
  ): { ok: true } | {
    ok: false;
    reason: 'device_not_found' | 'device_not_planned' | 'device_not_eligible' | 'invalid_candidate'
      | 'write_refused';
  } {
    const validated = this.resolveValidatedObjectiveEntry(deviceId, candidate);
    if (!validated.ok) return validated;
    const { device, entry } = validated;

    if (!this.deferredObjectivePlanHistoryRecorder || !this.deferredObjectiveActivePlanRecorder) {
      return { ok: false, reason: 'invalid_candidate' };
    }

    // Per-device-key write: touches only this device's settings key, so it
    // cannot drop a sibling task. When the candidate carries opt-in "Extra
    // permissions" (already eligibility-gated above), the entry's own `rescue` is
    // persisted as-is. When it does not, the default `preserve` policy keeps a
    // standing permission set elsewhere (e.g. by the budget-exempt rescue lane,
    // `rescueDeviceWithBudgetExemption`) intact rather than wiping it. The write
    // can still REFUSE on a transient un-confirmable migration or an untrustworthy
    // absence read; surface that as a retryable failure instead of a false
    // success so the widget can re-offer the create.
    const outcome = upsertObjectiveForDevice(
      buildDeferredObjectiveDeviceWriteDeps(this.ctx, {
        nowMs: this.getNow().getTime(),
        rebuildReason: 'flow_card:create_smart_task_widget',
      }),
      { deviceId, deviceName: device.name ?? null, entry },
    );
    if (!outcome.persisted) return { ok: false, reason: 'write_refused' };
    return { ok: true };
  }
  // Grant a device the starvation-rescue widget's bounded budget-exempt rescue.
  // A rescue is always a FRESH task: `getStarvedRescueDevices` only offers a
  // device that has no smart task yet (and this method re-asserts it), so there
  // is no merge — the rescue REUSES the create engine (`createDeferredObjective`).
  // The candidate carries the rescue permissions (`exemptFromBudget` always, plus
  // `limitLowerPriorityDevices`); `createDeferredObjective`'s
  // `gateCandidateExtraPermissions` then keeps the budget exemption for any device
  // and the limit-lower-priority grant only where it has effect (stepped + top
  // priority). This lifts the DAILY BUDGET and (where effective) grants priority
  // over lower-priority devices, but NEVER raises the physical capacity cap (the
  // hard cap is physical): the priority permission only displaces lower-priority
  // load WITHIN the cap. The budget-exemption assertion is defence-in-depth so it
  // can't be smuggled through a generic create — it doesn't rest solely on the
  // widget API being the only caller.
  public rescueDeviceWithBudgetExemption(
    deviceId: string,
    candidate: DeferredObjectivePlanPreviewCandidate,
  ): { ok: true } | {
    ok: false;
    reason: 'device_not_found' | 'device_not_planned' | 'device_not_eligible' | 'invalid_candidate'
      | 'write_refused';
  } {
    // Defence-in-depth (feedback_hard_cap_is_physical): this lane exists only to
    // grant a budget exemption; reject any candidate that does not carry one so
    // the exemption can never be smuggled in through a generic create.
    if (candidate.rescue?.exemptFromBudget !== 'always') {
      return { ok: false, reason: 'invalid_candidate' };
    }
    // Migrate any legacy-blob objective to per-keys BEFORE the eligibility check:
    // a task still only in the un-migrated blob is invisible to the per-key
    // `hasDeferredObjectiveForDevice`, so without this the delegated create would
    // migrate-then-REPLACE it, losing the user's target/deadline. (A transient-
    // empty store defers the migration; the device then still looks task-free
    // here, but `createDeferredObjective`'s own `ensureMigrated` guard refuses the
    // write rather than clobbering — so the user's task is safe either way.)
    migrateBlobToPerKeyIfNeeded(this.homey.settings);
    // A device that already has an open smart task is not rescuable. Re-assert
    // here (the list already excludes it) so this lane can never REPLACE a user's
    // active or paused future task: the rescue is strictly a fresh create.
    if (this.hasDeferredObjectiveForDevice(deviceId)) {
      return { ok: false, reason: 'device_not_eligible' };
    }
    return this.createDeferredObjective(deviceId, candidate);
  }
  private buildPlanHistoryUiPayload(
    accept?: (entry: DeferredObjectivePlanHistoryEntry) => boolean,
  ): SettingsUiDeferredObjectivePlanHistoryPayload {
    const snapshot = this.deferredObjectivePlanHistoryRecorder?.getHistorySnapshot();
    const entriesByDeviceId: Record<string, DeferredObjectivePlanHistoryEntry[]> = {};
    if (snapshot) {
      // Sort newest finalizedAtMs first within each device to match the UI expectation.
      const byDevice = new Map<string, DeferredObjectivePlanHistoryEntry[]>();
      for (const entry of snapshot.entries) {
        if (accept && !accept(entry)) continue;
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

  public getDeferredObjectivePlanHistoryUiPayload(): SettingsUiDeferredObjectivePlanHistoryPayload {
    return this.buildPlanHistoryUiPayload();
  }

  // Bounded variant for the smart-tasks widget: only entries finalized at/after
  // `sinceMs`. The widget refreshes every 60 s and only renders the last 24 h, so
  // serializing the full (unbounded, all-time) history each cycle is wasteful —
  // this keeps the payload proportional to recent activity.
  public getDeferredObjectivePlanHistoryRecentUiPayload(
    sinceMs: number,
  ): SettingsUiDeferredObjectivePlanHistoryPayload {
    return this.buildPlanHistoryUiPayload(
      (entry) => Number.isFinite(entry.finalizedAtMs) && entry.finalizedAtMs >= sinceMs,
    );
  }
  public applyPlanActions = (plan: DevicePlan) => this.planService.applyPlanActions(plan);
  public applySheddingToDevice = (deviceId: string, deviceName: string, reason?: string) =>
    this.planService.applySheddingToDevice(deviceId, deviceName, reason);
}

export = PelsApp;
