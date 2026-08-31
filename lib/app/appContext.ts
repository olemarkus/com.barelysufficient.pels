import type { ExpectedPowerOverridesByDeviceId, LearnedPeaksByDeviceId } from '../device/devicePowerPeak';
import type Homey from 'homey';
import type CapacityGuard from '../power/capacityGuard';
import type { DeviceTransport } from '../device/deviceTransport';
import type { PowerTrackerState } from '../power/tracker';
import type { DailyBudgetService } from '../dailyBudget/dailyBudgetService';
import type { DailyBudgetUiRead, DailyBudgetUpdateStateOptions } from '../dailyBudget/dailyBudgetTypes';
import type { DeferredObjectiveActivePlanRecorder } from '../objectives/deferredObjectives/activePlanRecorder';
import type { DeferredObjectivePlanHistoryRecorder } from '../objectives/deferredObjectives/planHistory';
import type { DeviceDiagnosticsService } from '../diagnostics/deviceDiagnosticsService';
import type { Logger as PinoLogger, StructuredDebugEmitter } from '../logging/logger';
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
import type { PriceLevel } from '../price/priceLevels';
import type { PriceCoordinator } from '../price/priceCoordinator';
import type { PriceFlowTagPublisher } from '../price/priceFlowTags';
import type { CombinedPricesReader } from '../price/combinedPricesReader';
import type { PriceOptimizationSettings } from '../price/priceOptimizer';
import type { CombinedHourlyPrice } from '../price/priceTypes';
import type { DebugLoggingTopic } from '../../packages/shared-domain/src/utils/debugLogging';
import type { CreateSmartTaskCandidateDevicesRead } from '../../packages/contracts/src/widgetHostApi';
import type {
  DecoratedDeviceSnapshot,
  DeviceControlProfiles,
  EvBoostConfig,
  EvBoostSettings,
  EvCarAssociations,
  ProjectedObservedDeviceState,
  TargetDeviceSnapshot,
  TemperatureBoostConfig,
  TemperatureBoostSettings,
} from '../../packages/contracts/src/types';
import type { DeviceTargetPowerConfigsWithReachability } from '../device/targetPowerReachability';
import type { HomeyDeviceLike } from '../utils/types';
import type { AppDeviceControlHelpers } from '../../setup/appDeviceControlHelpers';
import type { SteppedCommandStore } from '../executor/steppedCommandStore';
import type { SteppedReportedStepStore } from '../observer/steppedReportedStep';
import type { HomeMembershipPort } from '../home/membership';
import type { HomeRuntimeReadPort } from '../home/homeRuntimeRead';
import type { GenerationPollSource } from '../power/sources/generationPoll';
import type { HomeyEnergyPollSource } from '../power/sources/homeyEnergyPoll';
import type { PowerSampleRebuildState } from '../plan/rebuildScheduler/powerDriven';
import type { RefreshTargetDevicesSnapshotOptions, AppSnapshotHelpers } from '../../setup/appSnapshotHelpers';
import type { TimerRegistry } from '../utils/timerRegistry';
import type {
  FlowReportedCapabilitiesForDevice,
  FlowReportedCapabilityId,
} from '../device/transport/flowReportedCapabilities';
import type { PvForecastSourceUiStatus, SettingsUiPlanSnapshot } from '../../packages/contracts/src/settingsUiApi';
import type { PowerCalibrationSnapshot } from '../../packages/contracts/src/powerCalibration';
import type { PlanRebuildTrigger } from '../plan/planRebuildTrigger';
import type { FlowBackedCapabilityReportOutcome } from '../device/flowBackedCapabilityReport';

// Declared with the device layer, which produces it; re-exported here so the
// existing import sites are unchanged.
export type { FlowBackedCapabilityReportOutcome };


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
  applyPriceOptimizationImmediatelyOnStart?: boolean;
};

export type AppContext = {
  startupBootstrap?: StartupBootstrapConfig;
  homey: Homey.App['homey'];
  log: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
  logDebug: (topic: DebugLoggingTopic, ...args: unknown[]) => void;
  getStructuredLogger: (component: string) => PinoLogger | undefined;
  getStructuredDebugEmitter: (component: string, debugTopic: DebugLoggingTopic) => StructuredDebugEmitter;
  getNow: () => Date;
  getTimeZone: () => string;
  notifyOperatingModeChanged: (mode: string) => void;
  loadPowerTracker: (options?: { skipDailyBudgetUpdate?: boolean }) => void;
  loadCapacitySettings: () => void;
  /** Re-read only the validated live temperature-command authorization map. */
  loadTemperatureControlPolicySettings: () => void;
  loadPriceOptimizationSettings: () => void;
  updatePriceOptimizationEnabled: (logChange?: boolean) => void;
  updateDebugLoggingEnabled: (logChange?: boolean) => void;
  /** Restarts the hidden weather-history collector after its settings blob changes. */
  reloadWeatherCollector?: () => void;
  updateOverheadToken: (value?: number) => Promise<void>;
  registerFlowCards: () => void;
  refreshTargetDevicesSnapshot: (options?: RefreshTargetDevicesSnapshotOptions) => Promise<void>;
  recordPowerSample: (powerW: number, nowMs?: number) => Promise<PowerSampleAdmission>;
  handleOperatingModeChange: (rawMode: string) => Promise<void>;
  getFlowSnapshot: () => Promise<TargetDeviceSnapshot[]>;
  getCurrentPriceLevel: () => PriceLevel;
  /**
   * Both current-hour price flags from ONE combined-series build — see
   * `PriceService.getCurrentHourPriceLevel`. Replaces the separate
   * `isCurrentHourCheap`/`isCurrentHourExpensive` wiring fields: every consumer
   * through this context wanted both, and the two predicates rebuilt the
   * uncached series once each. The single-flag accessors still exist on
   * `PriceCoordinator`/`PriceService` for callers that genuinely need one.
   */
  getCurrentHourPriceLevel: () => PriceLevel;
  areFlowBackedCardsAvailable: () => boolean;
  setExpectedOverride: (deviceId: string, kw: number) => boolean;
  /**
   * Adopt the persisted manual expected-power figures into the live map after a
   * write to `DEVICE_EXPECTED_POWER_OVERRIDES` (the settings UI's "Power when
   * running" field). The runtime resolves expected power from that map, which is
   * otherwise loaded only at boot, so the settings handler must call this or a
   * UI write would not take effect until the next restart.
   */
  reloadExpectedPowerOverrides: () => void;
  storeFlowPriceData: (kind: 'today' | 'tomorrow', raw: unknown) => {
    dateKey: string;
    storedCount: number;
    missingHours: number[];
  };
  loadDailyBudgetSettings: () => void;
  updateDailyBudgetState: (options?: DailyBudgetUpdateStateOptions) => void;
  requestFlowPlanRebuild: (source: string) => void;
  /** App-wiring route to the PlanService that owns one device (main or sub-home). */
  rebuildOwningHomePlanForDevice?: (
    deviceId: string,
    trigger: PlanRebuildTrigger,
  ) => Promise<unknown>;
  getFlowReportedCapabilitiesForDevice: (deviceId: string) => FlowReportedCapabilitiesForDevice;
  getFlowReportedDeviceIds: () => string[];
  reportFlowBackedCapability: (params: {
    deviceId: string;
    capabilityId: FlowReportedCapabilityId;
    value: boolean | number | string;
  }) => FlowBackedCapabilityReportOutcome;
  getHomeyDevicesForFlow: () => Promise<HomeyDeviceLike[]>;
  emitFlowBackedRefreshRequests: (deviceIds: string[]) => Promise<void>;
  resolveModeName: (name: string) => string;
  getAllModes: () => Set<string>;
  resolveManagedState: (deviceId: string) => boolean;
  // Observer-owned maintained observed truth for a device, fed by the dispatcher
  // push (`lib/observer/observedDeviceStateProjection.ts`). `undefined` until the
  // first observation lands OR the boot/hot-plug seed fills it (see
  // `seedObservedStateFromSnapshot`).
  getObservedState: (deviceId: string) => ProjectedObservedDeviceState | undefined;
  /** Observer-owned accepted-write counter; see `ObservedDeviceStateProjection.getRevision`. */
  getObservationRevision: () => number;
  // Boot/hot-plug seed: fill the observed-state projection's EMPTY slots from the
  // RAW cached device snapshot so a reader (the settings-UI EV chip,
  // `toPlanDevice` freshness) sees the device's real state for cycle 1, before
  // the first dispatcher delta/refresh lands. Strictly additive — never clobbers
  // a recorded observation (see `ObservedDeviceStateProjection.seedMissing`). No
  // re-decoration, no device-manager re-entry: it reads `getSnapshot()` (the
  // cached array) and projects each entry via `projectObservedState`.
  seedObservedStateFromSnapshot: () => void;
  getCommunicationModel: (deviceId: string) => 'local' | 'cloud';
  isCapacityControlEnabled: (deviceId: string) => boolean;
  isTemperatureControlDisabled: (deviceId: string) => boolean;
  isBudgetExempt: (deviceId: string) => boolean;
  getTemperatureBoostConfig: (deviceId: string) => TemperatureBoostConfig | undefined;
  getEvBoostConfig: (deviceId: string) => EvBoostConfig | undefined;
  getShedBehavior: (deviceId: string) => ShedBehavior;
  computeDynamicSoftLimit: () => number;
  getDynamicSoftLimitOverride: () => number | null;
  logTargetRetryComparison?: (params: {
    deviceId: string;
    name: string;
    target: 'temperature';
    desired: number;
    observedValue?: unknown;
    observedSource?: string;
    retryCount: number;
    skipContext: 'plan' | 'shedding' | 'overshoot';
  }) => Promise<void> | void;
  syncLivePlanStateAfterTargetActuation?: (source: PendingTargetObservationSource) => boolean | void;
  evaluateHeadroomForDevice: (
    params: Parameters<PlanService['evaluateHeadroomForDevice']>[0],
  ) => HeadroomForDeviceDecision | null;
  getCombinedHourlyPrices: () => CombinedHourlyPrice[];
  getDailyBudgetUiPayload: () => DailyBudgetUiRead;
  getLatestPlanSnapshotForUi: () => SettingsUiPlanSnapshot | null;
  getPowerCalibrationSnapshot: () => PowerCalibrationSnapshot;
  get powerTracker(): PowerTrackerState;
  set powerTracker(value: PowerTrackerState);
  get capacitySettings(): { limitKw: number; marginKw: number };
  set capacitySettings(value: { limitKw: number; marginKw: number });
  get capacityDryRun(): boolean;
  set capacityDryRun(value: boolean);
  get operatingMode(): string;
  set operatingMode(value: string);
  get modeAliases(): Record<string, string>;
  set modeAliases(value: Record<string, string>);
  get capacityPriorities(): Record<string, Record<string, number>>;
  set capacityPriorities(value: Record<string, Record<string, number>>);
  get modeDeviceTargets(): Record<string, Record<string, number>>;
  set modeDeviceTargets(value: Record<string, Record<string, number>>);
  get controllableDevices(): Record<string, boolean>;
  set controllableDevices(value: Record<string, boolean>);
  get managedDevices(): Record<string, boolean>;
  set managedDevices(value: Record<string, boolean>);
  get budgetExemptDevices(): Record<string, boolean>;
  set budgetExemptDevices(value: Record<string, boolean>);
  get temperatureControlDisabledDevices(): Record<string, boolean>;
  set temperatureControlDisabledDevices(value: Record<string, boolean>);
  get temperatureControlPolicyState(): 'unavailable' | 'resolved';
  set temperatureControlPolicyState(value: 'unavailable' | 'resolved');
  get temperatureBoostSettings(): TemperatureBoostSettings;
  set temperatureBoostSettings(value: TemperatureBoostSettings);
  get evBoostSettings(): EvBoostSettings;
  set evBoostSettings(value: EvBoostSettings);
  get evCarAssociations(): EvCarAssociations;
  set evCarAssociations(value: EvCarAssociations);
  get deviceDriverOverrides(): Record<string, string>;
  set deviceDriverOverrides(value: Record<string, string>);
  get deviceControlProfiles(): DeviceControlProfiles;
  set deviceControlProfiles(value: DeviceControlProfiles);
  get deviceTargetPowerConfigs(): DeviceTargetPowerConfigsWithReachability;
  set deviceTargetPowerConfigs(value: DeviceTargetPowerConfigsWithReachability);
  get deviceCommunicationModels(): Record<string, 'local' | 'cloud'>;
  set deviceCommunicationModels(value: Record<string, 'local' | 'cloud'>);
  get shedBehaviors(): Record<string, ShedBehavior>;
  set shedBehaviors(value: Record<string, ShedBehavior>);
  get debugLoggingTopics(): Set<DebugLoggingTopic>;
  set debugLoggingTopics(value: Set<DebugLoggingTopic>);
  get defaultComputeDynamicSoftLimit(): (() => number) | undefined;
  set defaultComputeDynamicSoftLimit(value: (() => number) | undefined);
  get lastKnownPowerKw(): LearnedPeaksByDeviceId;
  get expectedPowerKwOverrides(): ExpectedPowerOverridesByDeviceId;
  get lastPositiveMeasuredPowerKw(): Record<string, { kw: number; ts: number }>;
  get lastNotifiedOperatingMode(): string;
  set lastNotifiedOperatingMode(value: string);
  get powerSampleRebuildState(): PowerSampleRebuildState;
  set powerSampleRebuildState(value: PowerSampleRebuildState);
  get latestTargetSnapshot(): DecoratedDeviceSnapshot[];
  getUiPickerDevices(): DecoratedDeviceSnapshot[];
  getCreateSmartTaskCandidateDevices(): CreateSmartTaskCandidateDevicesRead;
  get priceOptimizationEnabled(): boolean;
  get priceOptimizationSettings(): Record<string, PriceOptimizationSettings>;
  capacityGuard: CapacityGuard;
  readonly deferredObjectiveStatusBus: DeferredObjectiveStatusBus;
  readonly deferredObjectivePlanRevisionBus: DeferredObjectivePlanRevisionBus;
  readonly deferredObjectiveEndedBus: DeferredObjectiveEndedBus;
  readonly deferredObjectiveHoursRemainingBus: DeferredObjectiveHoursRemainingBus;
  readonly deferredObjectiveHoursRemainingTracker: DeferredObjectiveHoursRemainingTracker;
  dailyBudgetService?: DailyBudgetService;
  deferredObjectivePlanHistoryRecorder?: DeferredObjectivePlanHistoryRecorder;
  deferredObjectiveActivePlanRecorder?: DeferredObjectiveActivePlanRecorder;
  // Latched when startup back-fill bailed because the per-key migration marker was not yet
  // set (a boot-time empty `getKeys()` flake). The first observe tick after an in-session
  // migration retry completes re-runs the back-fill for the still-pending offline window
  // before advancing the watermark past it. See `runPendingDeferredObjectiveBackfill`.
  deferredObjectiveBackfillPending?: boolean;
  deviceDiagnosticsService?: DeviceDiagnosticsService;
  priceCoordinator?: PriceCoordinator;
  priceFlowTagPublisher?: PriceFlowTagPublisher;
  // Single combined-prices read boundary shared by every consumer (daily
  // budget, flow tags, plan service, deferred recorders). The adapter owns the
  // settings read + V1→V2 migration; consumers receive only typed results.
  readonly combinedPricesReader: CombinedPricesReader;
  deviceManager?: DeviceTransport;
  // Cached device→home membership for the multi-home feature: the read-only
  // join of the homes registry + pins + the transport's zone tree + snapshot
  // zone ids. Recomputed after each committed snapshot refresh, on zone-tree
  // commits, and on `homes_config`/`device_home_assignments` writes. NO
  // control-path consumer yet (the planner wiring lands in a sibling PR).
  // Typed as the lib/home PORT on purpose: ctx consumers get only the
  // provenance-free control surface — the diagnostics view (per-device
  // `source`) is reachable solely through the setup-internal seam the
  // `ui_homes` endpoint uses. Assigned by `AppServiceWiring.initHomeMembership`
  // and cleared at uninit; optional so tests building a bare context are
  // unaffected.
  homeMembership?: HomeMembershipPort;
  // Read-only access to each sub-home runtime's ALREADY-COMMITTED state (last
  // committed plan snapshot, that home's tracker state, bundle diagnostics) for
  // the settings UI. Typed as the lib/home PORT because the backing
  // `HomeRuntimeRegistry` is a private `AppServiceWiring` field that must not
  // be handed out — the same reason `homeMembership` is a port. Sub-homes only:
  // the main home keeps the existing unsuffixed ctx reads. Assigned by
  // `AppServiceWiring.initHomeRuntimeRegistry` and cleared at uninit; optional
  // so tests building a bare context are unaffected.
  homeRuntimeRead?: HomeRuntimeReadPort;
  planEngine?: PlanEngine;
  lifecycleFallback?: LifecycleFallbackPort;
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
  // PV-forecast source provenance for the settings UI, REPLACED by
  // `startPostStartupBackgroundTasks` (the wiring-assigns-ctx-members house
  // pattern) with a read of the live selector — never recomputed elsewhere.
  // Always answerable: before the forecast controllers exist the seam answers
  // the status union's own `unknown` member, so no consumer holds a nullable.
  getPvForecastSourceUiStatus: () => PvForecastSourceUiStatus;
  planService?: PlanService;
  // Released after the first device snapshot refresh succeeds, or after the
  // configured timeout — whichever comes first. Holds the first
  // `rebuildPlanFromCache` so the planner does not run against an empty
  // snapshot. Optional so tests that build a context without going through
  // `app.ts` are unaffected.
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
  readonly deviceControlHelpers: AppDeviceControlHelpers;
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
  | 'planService';

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
}
