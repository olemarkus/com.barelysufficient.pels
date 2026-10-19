import type { AcceptedFlowConflictSlice } from '../flowApi/acceptedFlowConflictStore';
import type { FlowCapabilityWrites } from '../flowApi/userFlows';
import type { ObservedTemperatureModeUpdates } from '../home/observedTemperatureModeUpdates';
import type { DeviceControlSettings } from '../device/deviceControlSettings';
import type { TrackerStore } from '../power/trackerStore';
import type { CapacitySettingsStore } from '../power/capacitySettingsStore';
import type { CapacityScalarSettings, PowerLimitSettings } from '../../packages/contracts/src/capacitySettings';
import type { UserdataDatabase } from '../store/userdataDatabase';
import type { PowerCalibrationStore } from '../device/devicePowerCalibrationStore';
import type { ObservedDeviceReads } from '../observer/observedDeviceStateProjection';
import type { LearnedPeaksByDeviceId } from '../device/devicePowerPeak';
import type Homey from 'homey';
import type CapacityGuard from '../power/capacityGuard';
import type { DeviceReads } from '../device/deviceReads';
import type { DeviceConfiguration } from '../device/deviceConfiguration';
import type { PlanInputSnapshotDevice } from '../planInput/runtimeDeviceRead';
import type { DeviceSurfaces } from '../../packages/contracts/src/deviceSurfaces';
import type { SettingsUiDeviceReads } from '../device/settingsUiDeviceReads';
import type { DeviceTransportPort } from '../device/deviceTransport';
import type { BuiltInControlFlowConflicts } from '../device/builtInControlFlowConflicts';
import type { PowerTrackerState } from '../power/tracker';
import type { DailyBudgetService } from '../dailyBudget/dailyBudgetService';
import type { DailyBudgetUiRead, DailyBudgetUpdateStateOptions } from '../dailyBudget/dailyBudgetTypes';
import type { DeferredObjectiveActivePlanRecorder } from '../objectives/deferredObjectives/activePlanRecorder';
import type { DeferredObjectivePlanHistoryRecorder } from '../objectives/deferredObjectives/planHistory';
import type { DeviceDiagnosticsService } from '../diagnostics/deviceDiagnosticsService';
import type { Logger as PinoLogger } from '../logging/logger';
import type { HeadroomForDeviceDecision } from '../plan/planHeadroomDevice';
import type {
  DeferredObjectiveEndedBus,
  DeferredObjectiveHoursRemainingBus,
  DeferredObjectiveHoursRemainingTracker,
  DeferredObjectivePlanRevisionBus,
  DeferredObjectiveStatusBus,
} from '../objectives/deferredObjectives';
import type { PlanEngine } from '../plan/planEngine';
import type { ExternalOffHoldPolicy } from '../observer/externalOffHold';
import type { SnapshotWarmupGate } from '../plan/snapshotWarmupGate';
import type { MeterSilenceMonitor } from '../power/meterSilence';
import type { PendingTargetObservationSource, ShedBehavior } from '../plan/planTypes';
import type { PlanService } from '../plan/planService';
import type { LifecycleFallbackPort } from '../executor/lifecycleFallbackDispatcher';
import type { BatteryControlOwner } from '../ports/batteryControlOwner';
import type { BatteryManagedSettings } from '../battery/batteryControlSettings';
import type { HomeBatteryDevicesRead } from '../ports/homeBatteryDevices';
import type { PriceCoordinator } from '../price/priceCoordinator';
import type { PriceFlowTagPublisher } from '../price/priceFlowTags';
import type { PriceOptimizationSettings } from '../price/priceOptimizer';
import type { DebugLoggingTopic } from '../../packages/shared-domain/src/utils/debugLogging';
import type { CreateSmartTaskCandidateDevicesRead } from '../../packages/contracts/src/widgetHostApi';
import type {
  DecoratedDeviceSnapshot,
  DeviceDescriptorRead,
  DeviceExpectedPowerOverrides,
  TargetDeviceSnapshot,
} from '../../packages/contracts/src/types';
import type { DeviceControlHelpers } from '../../setup/appDeviceControlHelpers';
import type { SteppedCommandStore } from '../executor/steppedCommandStore';
import type { SteppedReportedStepStore } from '../observer/steppedReportedStep';
import type { HomeMembershipPort } from '../home/membership';
import type { HomeRuntimeReadPort } from '../home/homeRuntimeRead';
import type { PlanStatusRegistry } from '../plan/planStatusRegistry';
import type { GenerationPollSource } from '../power/sources/generationPoll';
import type { HomeyEnergyPollSource } from '../power/sources/homeyEnergyPoll';
import type { PlanRebuildThrottle } from '../plan/rebuildScheduler/throttle';
import type { RefreshTargetDevicesSnapshotOptions, AppSnapshotHelpers } from '../../setup/appSnapshotHelpers';
import type { TimerRegistry } from '../utils/timerRegistry';
import type { FlowBackedDeviceState } from '../device/flowBackedDeviceState';
import type {
  HomeyPriceFormulaUiStatus,
  PowerhourSourceUiStatus, PvForecastSourceUiStatus, SettingsUiPlanSnapshot, SettingsUiPriceSourcePayloads,
} from '../../packages/contracts/src/settingsUiApi';
import type { PowerCalibrationSnapshot } from '../../packages/contracts/src/powerCalibration';
import type { PlanRebuildTrigger } from '../plan/planRebuildTrigger';
import type { EnergyTaskDeliveryTracker } from '../objectives/deferredObjectives/energyDelivery';


/**
 * Per-request result from the coalesced whole-home sample loop.
 *
 * `admitted` means this request is still the latest sample recorded when the
 * shared loop settles. `superseded` means a newer request won; callers must
 * not publish source-specific authority or freshness for the older request.
 */
export type PowerSampleAdmission =
  | { state: 'admitted'; revision: number }
  | { state: 'superseded'; revision: number; latestRevision: number };

export type StartupBootstrapConfig = {
  snapshotPlanBootstrapDelayMs?: number;
  overheadTokenDelayMs?: number;
  runSnapshotPlanBootstrapInBackground?: boolean;
  runPriceBootstrapInBackground?: boolean;
};

export type AppContext = {
  startupBootstrap?: StartupBootstrapConfig;
  homey: Homey.App['homey'];
  log: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
  getStructuredLogger: (component: string) => PinoLogger | undefined;
  getNow: () => Date;
  getTimeZone: () => string;
  notifyOperatingModeChanged: (mode: string) => void;
  hydratePowerTracker: () => void;
  /** The power tracker's rows in the userdata database; throws before the boot step that opens it. */
  getTrackerStore: () => TrackerStore;
  /**
   * The open userdata database, for a domain's wiring to build its repository
   * on (`setup/appInit/deferredRecorders.ts` is the pattern); throws before
   * the boot step that opens it.
   */
  getUserdataDatabase: () => UserdataDatabase;
  /**
   * The device power calibration store on the userdata database, which the
   * device transport feeds from its first observation; throws before the boot
   * step that opens it, and outlives the database close (see `app.ts`).
   */
  getPowerCalibrationStore: () => PowerCalibrationStore;
  /**
   * The charging-current routes' accepted Flow writes, kept across a restart;
   * reading throws before the boot step that opens the userdata database.
   */
  getChargingFlowWritesStore: () => AcceptedFlowConflictSlice<FlowCapabilityWrites>;
  /** The Flow scan behind built-in device control: native wiring's answer, and the periodic re-query. */
  builtInControlFlowConflicts: BuiltInControlFlowConflicts;
  /** Tell the settings UI a home's tracker persisted (the store produces no settings echo). */
  emitPowerTrackerPersisted: (homeId: string) => void;
  /** SDK-bound Main-home capacity reader, constructed once at the composition root. */
  capacitySettingsStore: CapacitySettingsStore;
  loadCapacitySettings: () => void;
  /**
   * An explicit write of a settings key landed, ahead of the settings handler's
   * write dedupe: the capacity owner opens a fresh retry window for a carried
   * key (`CapacitySettingsReloader.noteWritten`).
   */
  noteCapacitySettingWritten: (key: string) => void;
  /** The settings handler's dedupe skipped this key (`CapacitySettingsReloader.recoverAfterSkippedWrite`). */
  recoverCapacitySettingsAfterSkippedWrite: (key: string) => void;
  updateDebugLoggingEnabled: (logChange?: boolean) => void;
  /** Restarts the hidden weather-history collector after its settings blob changes. */
  reloadWeatherCollector: () => void;
  updateOverheadToken: (value?: number) => Promise<void>;
  registerFlowCards: () => void;
  registerWidgetSettings: () => void;
  refreshTargetDevicesSnapshot: (options?: RefreshTargetDevicesSnapshotOptions) => Promise<void>;
  recordPowerSample: (powerW: number, nowMs?: number) => Promise<PowerSampleAdmission>;
  handleOperatingModeChange: (rawMode: string) => Promise<void>;
  getFlowSnapshot: () => Promise<TargetDeviceSnapshot[]>;
  loadDailyBudgetSettings: () => void;
  updateDailyBudgetState: (options?: DailyBudgetUpdateStateOptions) => void;
  /** App-wiring route to the PlanService that owns one device (main or sub-home). */
  rebuildOwningHomePlanForDevice?: (
    deviceId: string,
    trigger: PlanRebuildTrigger,
  ) => Promise<unknown>;
  /**
   * Flow-backed device state (`lib/device/flowBackedDeviceState.ts`): the
   * capability values Flow cards report, the manual expected-power figures, and
   * the learned power peaks.
   */
  readonly flowBacked: FlowBackedDeviceState;
  resolveManagedState: (deviceId: string) => boolean;
  // The home batteries the device layer knows, `unavailable` before it exists
  // or has settled them (`lib/device/deviceRoleReads.ts`).
  readHomeBatteryDevices: () => HomeBatteryDevicesRead;
  /**
   * Observer-owned maintained observed truth, fed by the dispatcher push
   * (`lib/observer/observedDeviceStateProjection.ts`): the general read, the
   * whole record for the consumers that hold it, one named read per observed
   * cluster, and the accepted-write counter. A port, so no consumer reaches the
   * projection's writes.
   */
  readonly observer: ObservedDeviceReads;
  isCapacityControlEnabled: (deviceId: string) => boolean;
  isTemperatureControlDisabled: (deviceId: string) => boolean;
  getShedBehavior: (deviceId: string) => ShedBehavior;
  /** Every setpoint a limit may write to this device, either direction (`resolveTemperaturePolicyShedLimitsC`). */
  getShedLimitTemperaturesC: (deviceId: string) => readonly number[];
  /**
   * One member with two meanings, decided by who assigned it:
   * - As wired (`setup/appHostApi.ts`), the planner's live physical limit
   *   (`PlanService.computePhysicalPowerLimit`): the lower of the capacity pace
   *   and the grid import target, `null` with both off. The Flow headroom cards
   *   read it as that (`setup/appInit/registerAppFlowCards.ts`).
   * - Assigned by a spec, a capacity PACE. `getDynamicSoftLimitOverride` sees
   *   the member differ from the captured `defaultComputeDynamicSoftLimit`, and
   *   the main home's planner takes the value as its capacity pace while
   *   Capacity limit is on, still bounding it by the grid import target. The
   *   Flow headroom cards in that spec read the same value as the physical
   *   limit, grid target not applied.
   * The name is the capacity pace's older one.
   */
  computeDynamicSoftLimit: () => number | null;
  getDynamicSoftLimitOverride: () => number | null;
  syncLivePlanStateAfterTargetActuation: (source: PendingTargetObservationSource) => boolean | void;
  evaluateHeadroomForDevice: (
    params: Parameters<PlanService['evaluateHeadroomForDevice']>[0],
  ) => HeadroomForDeviceDecision;
  getDailyBudgetUiPayload: () => DailyBudgetUiRead;
  getLatestPlanSnapshotForUi: () => SettingsUiPlanSnapshot | null;
  getPowerCalibrationSnapshot: () => PowerCalibrationSnapshot;
  get powerTracker(): PowerTrackerState;
  set powerTracker(value: PowerTrackerState);
  /** Persistently re-prime Main after a meter/source change; transient write failure retries internally. */
  resetMainPowerTrackerFreshness(): void;
  /** This home's capacity scalars as the running app holds them, already resolved. */
  getCapacityScalars(): CapacityScalarSettings;
  getCurrentMonthCapacityPeakKw(): number | null;
  get capacitySettings(): PowerLimitSettings;
  set capacitySettings(value: PowerLimitSettings);
  get capacityDryRun(): boolean;
  set capacityDryRun(value: boolean);
  /** The owner's per-device control configuration (`lib/device/deviceControlSettings.ts`). */
  readonly deviceControlSettings: DeviceControlSettings;
  readonly observedTemperatureModeUpdates: ObservedTemperatureModeUpdates;
  get debugLoggingTopics(): Set<DebugLoggingTopic>;
  set debugLoggingTopics(value: Set<DebugLoggingTopic>);
  get defaultComputeDynamicSoftLimit(): (() => number | null) | undefined;
  set defaultComputeDynamicSoftLimit(value: (() => number | null) | undefined);
  get lastKnownPowerKw(): LearnedPeaksByDeviceId;
  get expectedPowerKwOverrides(): DeviceExpectedPowerOverrides;
  get lastNotifiedOperatingMode(): string;
  set lastNotifiedOperatingMode(value: string);
  /** The main home's rebuild throttle (`lib/plan/rebuildScheduler/throttle.ts`); sub-homes own their own. */
  get planRebuildThrottle(): PlanRebuildThrottle;
  /** Plan/executor runtime inputs joined from DeviceConfiguration and Observer. */
  getPlanInputSnapshot(): PlanInputSnapshotDevice[];
  /** Inventory metadata joined with accepted Observer state for consumers needing both. */
  getDeviceSurfaces(): DeviceSurfaces[];
  getUiPickerDevices(): DecoratedDeviceSnapshot[];
  /**
   * The Flow-card device list as descriptors — identity and config, no
   * observations. Same value and same lazy refresh as `getFlowSnapshot`; the
   * narrower declared type is the point.
   */
  getFlowDeviceDescriptors(): Promise<DeviceDescriptorRead[]>;
  /**
   * The same descriptors, synchronously, for wiring that reads them off the
   * committed snapshot rather than through the Flow-card lazy refresh.
   */
  getDeviceDescriptors(): DeviceDescriptorRead[];
  /** One device's descriptor, or `undefined` for an untracked id. */
  getDeviceDescriptor(deviceId: string): DeviceDescriptorRead | undefined;
  /**
   * Inventory metadata reads (`lib/device/deviceReads.ts`). Runtime observations
   * are read from Observer; configuration is read from `deviceConfiguration`.
   * The raw snapshot stays private behind the device transport port.
   */
  readonly deviceReads: DeviceReads;
  readonly settingsUiDeviceReads: SettingsUiDeviceReads;
  /** Runtime configuration source, separate from inventory reads and observations. */
  readonly deviceConfiguration: DeviceConfiguration;
  getCreateSmartTaskCandidateDevices(): CreateSmartTaskCandidateDevicesRead;
  get priceOptimizationSettings(): Record<string, PriceOptimizationSettings>;
  capacityGuard: CapacityGuard;
  /**
   * Every home's live status, published by its plan service after a rebuild
   * and read by the settings-UI API, the widget and the Insights driver. In
   * memory, never a settings key: `lib/plan/planStatusRegistry.ts`.
   */
  readonly planStatuses: PlanStatusRegistry;
  readonly deferredObjectiveStatusBus: DeferredObjectiveStatusBus;
  readonly deferredObjectivePlanRevisionBus: DeferredObjectivePlanRevisionBus;
  readonly deferredObjectiveEndedBus: DeferredObjectiveEndedBus;
  readonly deferredObjectiveHoursRemainingBus: DeferredObjectiveHoursRemainingBus;
  readonly deferredObjectiveHoursRemainingTracker: DeferredObjectiveHoursRemainingTracker;
  dailyBudgetService?: DailyBudgetService;
  deferredObjectivePlanHistoryRecorder?: DeferredObjectivePlanHistoryRecorder;
  deferredObjectiveActivePlanRecorder?: DeferredObjectiveActivePlanRecorder;
  deferredObjectiveEnergyDelivery?: EnergyTaskDeliveryTracker;
  // Latched when startup back-fill bailed because the per-key migration marker was not yet
  // set (a boot-time empty `getKeys()` flake). The first observe tick after an in-session
  // migration retry completes re-runs the back-fill for the still-pending offline window
  // before advancing the watermark past it. See `runPendingDeferredObjectiveBackfill`.
  deferredObjectiveBackfillPending?: boolean;
  deviceDiagnosticsService?: DeviceDiagnosticsService;
  /**
   * Owns the price caches and the single combined-prices read boundary every
   * consumer reads through (`combinedPricesReader`: daily budget, flow tags,
   * deferred recorders, the objective price horizon).
   */
  priceCoordinator?: PriceCoordinator;
  priceFlowTagPublisher?: PriceFlowTagPublisher;
  /**
   * The transport as everything OUTSIDE `lib/device` may hold it: writes, the
   * by-id read, the zone tree, the producer predicates — but not `getSnapshot`.
   * The cached array has one owner now (`deviceReads`), and a port that cannot
   * hand it out is what keeps it that way. `app.ts` holds the concrete class and
   * builds the reads from it.
   */
  deviceManager?: DeviceTransportPort;
  // Cached device→home membership for the multi-home feature: the read-only
  // join of the homes registry + pins + the transport's zone tree + snapshot
  // zone ids. Recomputed after each committed snapshot refresh, on zone-tree
  // commits, and on `homes_config`/`device_home_assignments` writes.
  // Typed as the lib/home PORT on purpose: ctx consumers get only the
  // provenance-free control surface — the diagnostics view (per-device
  // `source`) is reachable solely through the setup-internal seam the
  // `ui_homes` endpoint uses. Assigned by `AppServiceWiring.initHomeMembership`.
  // Optional for two real reasons: Main's mode catalog reads it before that
  // step, and `runUninit` clears it so in-flight work that resumes after
  // shutdown stops recomputing. A caller that only runs inside its lifetime
  // reads it through `requireHomeMembership`.
  homeMembership?: HomeMembershipPort;
  // Read-only access to each sub-home runtime's ALREADY-COMMITTED state (last
  // committed plan snapshot, that home's tracker state, bundle diagnostics) for
  // the settings UI. Typed as the lib/home PORT because the backing
  // `HomeRuntimeRegistry` is a private field of the app that must not be handed
  // out — the same reason `homeMembership` is a port. Sub-homes only: the main
  // home keeps the existing unsuffixed ctx reads. Built once over the app's
  // registry handle, so it answers `unavailable` before
  // `initHomeRuntimeRegistry` and again after `runUninit` drops the registry.
  readonly homeRuntimeRead: HomeRuntimeReadPort;
  planEngine?: PlanEngine;
  lifecycleFallback?: LifecycleFallbackPort;
  // The Main home's battery control owner: claim admission, claim records and
  // hand-back. ASSIGNED by the `initBatteryControl` startup step
  // (`AppServiceWiring.initBatteryControl`, after home membership), so boot
  // recovery runs on the first committed snapshot; the settings handler
  // reaches it here.
  batteryControl?: BatteryControlOwner;
  // The owner's Managed map per home battery: one answer from app start, before
  // the battery control owner exists, which delegates to it once it does.
  batteryManaged: BatteryManagedSettings;
  // "Leave off until turned on again": the opt-in config plus the per-device
  // hold state recording that a device was turned off outside PELS, independent
  // of the current plan. ASSIGNED by `AppServiceWiring.initDeviceManager`
  // (the wiring-assigns-ctx-members house pattern) so it exists before the
  // first plan cycle can resume anything. Consumers get only the resolved
  // policy — never the provenance evidence, which is settled once at the
  // transport ingest seam. See `lib/observer/externalOffHold.ts`.
  externalOffHold?: ExternalOffHoldPolicy;
  // Curtailment-surplus estimator seams, both ASSIGNED by `wireCurtailmentSurplus`
  // post-startup (the wiring-assigns-ctx-members house pattern): the read of the
  // inferred curtailed-surplus term the plan wiring consumes — always a kW, >= 0,
  // because declining to claim a term IS 0 kW spare — and the co-sampled push
  // feed from the power pipeline. Both are absent until the wiring runs —
  // fail-closed, same precedent as the budget-price PV inputs.
  getCurtailedSurplusKw?: () => number;
  recordCurtailmentSample?: (netW: number, generationW: number | undefined, nowMs: number) => void;
  // Standing capability, not the current term: "could an inferred curtailment
  // term ever arrive for this home?". Gates the `surplusOnly` posture via
  // `resolveSurplusPoolReachable` — a device stamped on a pool that can never
  // open is held OFF forever. Absent (pre-wiring) reads as false; the estimator
  // persists the underlying latch, so this is a brief boot window rather than a
  // nightly one.
  canContributeCurtailmentSurplus?: () => boolean;
  // Whether the home's solar-surplus pool can ever open
  // (`lib/power/surplusPoolReachable.ts`): the one answer both the `surplusOnly`
  // posture and the "Use solar surplus" toggle read, so they cannot disagree.
  // Composed once, from the feed's persisted export latch and the curtailment
  // estimator above; resetting or pruning usage history cannot unmake it.
  isSurplusPoolReachable: () => boolean;
  // PV-forecast source provenance for the settings UI, REPLACED by
  // `startPostStartupBackgroundTasks` (the wiring-assigns-ctx-members house
  // pattern) with a read of the live selector — never recomputed elsewhere.
  // Always answerable: before the forecast controllers exist the seam answers
  // the status union's own `unknown` member, so no consumer holds a nullable.
  getPvForecastSourceUiStatus: () => PvForecastSourceUiStatus;
  /** Why a Homey-priced home has no prices, for the settings UI to explain. */
  getHomeyPriceFormulaUiStatus: () => HomeyPriceFormulaUiStatus;
  /**
   * What the Power by the Hour app answered when PELS last asked it for prices,
   * and which of its price devices the owner can choose between.
   */
  getPowerhourSourceUiStatus: () => PowerhourSourceUiStatus;
  /** The payload-fed price sources' stored days and currencies, for the settings UI. */
  getPriceSourcePayloadsForUi: () => SettingsUiPriceSourcePayloads;
  /** The stored combined prices as they are, for the settings UI and the plan widget. */
  getCombinedPricesForUi: () => unknown;
  planService?: PlanService;
  // Released after the first device snapshot refresh succeeds, or after the
  // configured timeout — whichever comes first. Holds the first
  // `rebuildPlanFromCache` so the planner does not run against an empty
  // snapshot. Built by the `initPlanRuntime` startup step, so it is required
  // once startup completes (`InitializedServiceKey`); its timeout starts at
  // construction, which is why it is not built earlier.
  snapshotWarmupGate?: SnapshotWarmupGate;
  /**
   * Main's 10-minute meter-silence policy (`lib/power/meterSilence.ts`): the
   * wiring composes its block into the plan-build gate and the escalation
   * clock drives its one shed pass. Sub-homes carry their own on the bundle.
   */
  meterSilenceMonitor: MeterSilenceMonitor;
  readonly snapshotHelpers: AppSnapshotHelpers;
  readonly homeyEnergyHelpers: HomeyEnergyPollSource;
  /**
   * Production companion poll. Active only on the flow source, where net comes
   * from a Flow card and nothing else reads `totalGenerated.W`.
   */
  readonly generationPollSource: GenerationPollSource;
  readonly deviceControlHelpers: DeviceControlHelpers;
  /** The stepped axis's two stores: what PELS commanded, and what the device attested. */
  readonly steppedCommandStore: SteppedCommandStore;
  readonly steppedReportedStore: SteppedReportedStepStore;
  readonly timers: TimerRegistry;
};

type InitializedServiceKey =
  | 'dailyBudgetService'
  | 'deviceDiagnosticsService'
  | 'priceCoordinator'
  | 'deviceManager'
  | 'planEngine'
  | 'planService'
  | 'snapshotWarmupGate';

/**
 * Trusted context after ordered startup has constructed every required service.
 * Boot wiring carries {@link AppContext}; post-startup wiring crosses this
 * assertion-backed boundary once and then consumes required service handles.
 */
export type InitializedAppContext = AppContext & Required<Pick<AppContext, InitializedServiceKey>>;

/** Assert the single transition from boot wiring to the trusted live context. */
export function requireInitializedAppContext(ctx: AppContext): asserts ctx is InitializedAppContext {
  if (!ctx.dailyBudgetService) throw new Error('DailyBudgetService must be initialized');
  if (!ctx.deviceDiagnosticsService) throw new Error('DeviceDiagnosticsService must be initialized');
  if (!ctx.priceCoordinator) throw new Error('PriceCoordinator must be initialized');
  if (!ctx.deviceManager) throw new Error('DeviceTransport must be initialized');
  if (!ctx.planEngine) throw new Error('PlanEngine must be initialized');
  if (!ctx.planService) throw new Error('PlanService must be initialized');
  if (!ctx.snapshotWarmupGate) throw new Error('SnapshotWarmupGate must be initialized');
}
