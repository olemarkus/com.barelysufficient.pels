import { createHomeModeCatalog } from './lib/home/homeModeCatalog';
import Homey from 'homey';
import type { LearnedPeaksByDeviceId } from './lib/device/devicePowerPeak';
import type { DeviceExpectedPowerOverrides } from './packages/contracts/src/types';
import type CapacityGuard from './lib/power/capacityGuard';
import type { DeviceTransport } from './lib/device/deviceTransport';
import { SettingsUiDeviceReads } from './lib/device/settingsUiDeviceReads';
import { DeviceControlSettings } from './lib/device/deviceControlSettings';
import { createDeviceReadSources, joinObservedDeviceDescriptors } from './lib/device/deviceReadSources';
import { ObservedStateEmitter } from './lib/observer/observedStateEvents';
import { ObservedHomePower } from './lib/observer/observedHomePower';
import { ObservedDeviceStateProjection } from './lib/observer/observedDeviceStateProjection';
import type { PlanEngine } from './lib/plan/planEngine';
import type { PlanService } from './lib/plan/planService';
import type { SnapshotWarmupGate } from './lib/plan/snapshotWarmupGate';
import type { PriceCoordinator } from './lib/price/priceCoordinator';
import type { PriceFlowTagPublisher } from './lib/price/priceFlowTags';
import type { DailyBudgetService } from './lib/dailyBudget/dailyBudgetService';
import {
  createDeferredObjectiveEndedBus,
  createDeferredObjectiveHoursRemainingBus,
  createDeferredObjectiveHoursRemainingTracker,
  createDeferredObjectivePlanRevisionBus,
  createDeferredObjectiveStatusBus,
  type DeferredObjectiveActivePlanRecorder,
  type DeferredObjectivePlanHistoryRecorder,
  type DeferredObjectiveEndedBus,
  type DeferredObjectiveHoursRemainingBus,
  type DeferredObjectiveHoursRemainingTracker,
  type DeferredObjectivePlanRevisionBus,
  type DeferredObjectiveStatusBus,
} from './lib/objectives/deferredObjectives';
import { createPlanStatusRegistry, type PlanStatusRegistry } from './lib/plan/planStatusRegistry';
import { createDeviceControlHelpers } from './setup/appDeviceControlHelpers';
import { createSteppedStores, type SteppedStores } from './setup/appInit/createSteppedStores';
import { DEFERRED_OBJECTIVE_HOURS_REMAINING_LATCH, MAIN_HOME_ID } from './lib/utils/settingsKeys';
import type { PlanRebuildThrottle } from './lib/plan/rebuildScheduler/throttle';
import { createBackgroundTasks, type BackgroundTasks } from './setup/appInit/createBackgroundTasks';
import { createHomePowerPipeline, createMeterSilenceMonitor } from './setup/homeRuntime/createHomePowerPipeline';
import { SettingsRepository } from './setup/settingsRepository';
import type { PowerCalibrationStore } from './lib/device/devicePowerCalibrationStore';
import type { PlanRebuildScheduler } from './lib/plan/rebuildScheduler/scheduler';
import type { AppContext, StartupBootstrapConfig } from './lib/app/appContext';
import type { PelsHost } from './lib/app/pelsHost';
import { createCapacitySettingsReloader, createCapacitySettingsStore } from './lib/power/capacitySettingsStore';
import { BatteryManagedSettings } from './lib/battery/batteryControlSettings';
import type {
  HomeyPriceFormulaUiStatus, PowerhourSourceUiStatus, PvForecastSourceUiStatus, SettingsUiPriceSourcePayloads,
} from './packages/contracts/src/settingsUiApi';
import { createModeDeviceTargetFill } from './setup/appInit/createSnapshotSettingsPasses';
import { normalizeError } from './lib/utils/errorUtils';
import type { DeviceDiagnosticsService } from './lib/diagnostics/deviceDiagnosticsService';
import { createGenerationPollSource } from './setup/appInit/createGenerationPollSource';
import { createHomeyEnergyPollSource, resolveMainMeterRead } from './setup/appInit/createHomeyEnergyPollSource';
import type { SubHomeMeters } from './lib/home/homeMeters';
import { AppSnapshotHelpers, createTargetPowerReachabilityAppWiring } from './setup/appSnapshotHelpers';
import { createFlowBackedDeviceState } from './setup/flowBackedCardAccess';
import { AppSmartTaskApi } from './setup/appSmartTaskApi';
import { AppSmartTaskPayloads } from './setup/appSmartTaskPayloads';
import {
  createHomeRebuildRuntime,
} from './lib/plan/rebuildScheduler/homeRebuildRuntime';
import { BuiltInControlFlowConflicts } from './lib/device/builtInControlFlowConflicts';
import {
  createChargingFlowWritesStore, createNativeFlowConflictStore, whileDatabaseOpen,
  type AcceptedFlowConflictSlice, type NativeFlowConflicts,
} from './lib/flowApi/acceptedFlowConflictStore';
import type { FlowCapabilityWrites } from './lib/flowApi/userFlows';
import {
  AppServiceWiring,
  createHomeRuntimeRegistryForApp,
  buildHomeRuntimeReadPort,
} from './setup/appServiceWiring';
import type { PowerTrackerState } from './lib/power/trackerTypes';
import {
  AppPowerTracker, createPowerCalibrationStoreForApp, createTrackerStoreForApp,
} from './setup/appPowerTracker';
import type { TrackerStore } from './lib/power/trackerStore';
import type { UserdataDatabase } from './lib/store/userdataDatabase';
import { TimerRegistry } from './lib/utils/timerRegistry';
import { ShutdownLatch } from './lib/utils/shutdownLatch';
import type { AppRuntimeHandles } from './setup/appRuntimeHandles';
import type { FlowReportedCapabilitiesByDevice } from './lib/device/transport/flowReportedCapabilities';
import { withAppApi } from './setup/appRuntimeApi';
import type { EnergyTaskDeliveryTracker } from './lib/objectives/deferredObjectives/energyDelivery';

const PelsAppBase = withAppApi(Homey.App);

class PelsApp extends PelsAppBase implements AppContext, PelsHost {
  protected readonly context: AppContext = this;
  // Handles to the services ordered startup constructs. They live here — the
  // composition root — rather than inside `AppServiceWiring`, which builds them
  // and hands them over.
  protected readonly runtime: AppRuntimeHandles = {};
  // Tripped once, as the first edge of uninit; every in-flight continuation
  // that must not act on a stopping app reads it.
  private readonly shutdown = new ShutdownLatch();
  public startupBootstrap?: StartupBootstrapConfig;
  // Latched when startup back-fill bailed because the per-key migration marker
  // was not yet set; consumed by the deferred-objective back-fill (see
  // `setup/appInit/deferredRecorders.ts`).
  public deferredObjectiveBackfillPending?: boolean;
  public get powerTracker(): PowerTrackerState { return this.mainTracker.getState(); }
  public set powerTracker(value: PowerTrackerState) { this.mainTracker.adopt(value); }
  public resetMainPowerTrackerFreshness(): void { this.mainTracker.resetFreshness(); }
  public capacityGuard!: CapacityGuard;
  public readonly planStatuses: PlanStatusRegistry = createPlanStatusRegistry();
  public readonly deferredObjectiveStatusBus: DeferredObjectiveStatusBus = createDeferredObjectiveStatusBus();
  public readonly deferredObjectivePlanRevisionBus: DeferredObjectivePlanRevisionBus
    = createDeferredObjectivePlanRevisionBus();
  public readonly deferredObjectiveEndedBus: DeferredObjectiveEndedBus
    = createDeferredObjectiveEndedBus();
  public readonly deferredObjectiveHoursRemainingBus: DeferredObjectiveHoursRemainingBus
    = createDeferredObjectiveHoursRemainingBus();
  // Persist the integer-hour crossing latch via settings so an already-crossed
  // threshold doesn't re-fire after an app restart. A throwing/missing read on
  // cold-start is treated as "no persisted state" — the tracker falls back to
  // first-observation seeding (pre-persistence behaviour). Per
  // `feedback_homey_sdk_unreliable`, never wipe the latch on a single bad read.
  public readonly deferredObjectiveHoursRemainingTracker: DeferredObjectiveHoursRemainingTracker
    = createDeferredObjectiveHoursRemainingTracker({
      load: () => this.homey.settings.get(DEFERRED_OBJECTIVE_HOURS_REMAINING_LATCH),
      save: (latch) => {
        try {
          this.homey.settings.set(DEFERRED_OBJECTIVE_HOURS_REMAINING_LATCH, latch);
        } catch (error) {
          this.getStructuredLogger('deferred_objectives')?.error({
            event: 'deferred_objective_hours_remaining_latch_persist_failed', err: normalizeError(error),
          });
        }
      },
    });
  public capacitySettings: AppContext['capacitySettings'] = {
    limitKw: 10, marginKw: 0.2, periodMinutes: 60, capacityEnabled: true, gridImportLimitKw: null,
  };
  public capacityDryRun = true;
  public readonly capacitySettingsStore = createCapacitySettingsStore(
    this.homey.settings,
    MAIN_HOME_ID,
    () => ({ ...this.capacitySettings, dryRun: this.capacityDryRun }),
  );
  public readonly deviceControlSettings = new DeviceControlSettings(this.homey.settings);
  public readonly batteryManaged = new BatteryManagedSettings(this.homey.settings);
  public readonly homeModeCatalog = createHomeModeCatalog(
    MAIN_HOME_ID,
    this.homey.settings,
    () => this.homeModeCatalog.getSnapshot(),
    () => this.deviceControlSettings.managedDevices,
    () => this.context.homeMembership,
    () => this.getStructuredLogger('homes'),
    () => this.readHomeBatteryDevices(),
  );
  protected readonly getHomeOperatingMode = () => this.homeModeCatalog.getOperatingMode();
  protected readonly setHomeOperatingMode = (mode: string) => this.homeModeCatalog.setOperatingMode(mode);
  protected readonly reloadHomeModeCatalog = () => this.homeModeCatalog.reload();
  protected readonly readGoverningModeTargetC = (deviceId: string) => (
    this.homeModeCatalog.readGoverningModeDeviceTargetC(deviceId)
  );
  protected readonly resolveHomeModeName = (mode: string) => this.homeModeCatalog.resolveModeName(mode);
  protected readonly getHomeModeNames = () => this.homeModeCatalog.getAllModes();
  protected readonly listDeviceTargetModes = (deviceId: string) => this.homeModeCatalog.listDeviceTargetModes(deviceId);
  protected readonly setDeviceModeTarget = this.homeModeCatalog.setDeviceModeTarget;
  /** Narrow settings bridge; the UI never receives the catalog owner itself. */
  public getModePrioritiesForUi = (deviceIds: readonly string[]) => (
    this.homeModeCatalog.getPrioritiesForDevices(deviceIds)
  );
  protected flowReportedCapabilities: FlowReportedCapabilitiesByDevice = {};
  public dailyBudgetService!: DailyBudgetService;
  public deferredObjectivePlanHistoryRecorder?: DeferredObjectivePlanHistoryRecorder;

  public deferredObjectiveActivePlanRecorder?: DeferredObjectiveActivePlanRecorder;

  public deferredObjectiveEnergyDelivery?: EnergyTaskDeliveryTracker;
  public deviceDiagnosticsService!: DeviceDiagnosticsService;
  public priceCoordinator!: PriceCoordinator;
  public priceFlowTagPublisher?: PriceFlowTagPublisher;
  public deviceManager!: DeviceTransport;
  public readonly settingsUiDeviceReads = new SettingsUiDeviceReads();

  /**
   * Every device read, built here because this is where the concrete transport
   * lives: `AppContext.deviceManager` is a port without `getSnapshot`, so the
   * composition root is the only place that can hand the cached array to its
   * owner. Lazy on both sides — the transport is wired during ordered startup,
   * and the observed record comes from the projection built with it.
   */
  private readonly deviceReadSources = createDeviceReadSources(() => this.deviceManager);
  public get deviceReads() { return this.deviceReadSources.deviceReads; }
  public get deviceConfiguration() { return this.deviceReadSources.deviceConfiguration; }

  public getDeviceSurfaces() {
    return joinObservedDeviceDescriptors(
      this.deviceReads.descriptors(),
      (deviceId) => this.observer.getObservedRecord(deviceId),
    );
  }
  /**
   * Observer-owned emitter for post-translation realtime events
   * (`observed-state-changed`, `observed-control-state-changed`). Wiring builds
   * it during `initDeviceManager`, binds transport's dispatcher to it,
   * and subscribes wiring's own reapply/SoC/perf listeners to it. Per
   * PR #5 of the observer/transport split, transport never statically
   * imports observer; the dispatcher flows in via DeviceTransport's
   * constructor options
   * (notes/state-management/observer-transport-split.md).
   */
  private readonly observedStateEmitter: ObservedStateEmitter = new ObservedStateEmitter();
  // Observer-owned whole-home power scalar (PR2a of the observer/transport
  // split). Transport pushes the Homey-SDK-sourced reading here via the
  // dispatcher; Homey Energy sample paths use the co-temporal transport return.
  private readonly observedHomePower: ObservedHomePower = new ObservedHomePower();
  // Observer-owned maintained projection of `ObservedDeviceState`, fed by the
  // dispatcher push (per-capability deltas + full-refresh batches). The context
  // hands it out as its read port (`AppContext.observer`); the service wiring
  // holds the concrete class to subscribe its writes. Same lifecycle as the
  // device manager and emitter: one per run.
  public readonly observer = new ObservedDeviceStateProjection();
  public planEngine!: PlanEngine;
  public planService!: PlanService;
  // Created in `onInit` (after the structured logger is wired) and released
  // by `bootstrapSnapshotAndPlan` once the first `refreshSnapshot()`
  // resolves, or by its own bound when the snapshot fetch fails/stalls.
  // Held by `PlanService.rebuildPlanFromCache` so any rebuild triggered
  // between `initDeviceManager` and the first snapshot (price refresh,
  // settings change, realtime device event, flow card) waits for either
  // outcome instead of running the planner against an empty snapshot.
  public snapshotWarmupGate?: SnapshotWarmupGate;
  // Curtailment-surplus estimator seams (optional AppContext members) —
  // ASSIGNED by `wireCurtailmentSurplus` post-startup; declared here so the
  // main pipeline's field-initializer tap below can reference them on `this`.
  public getCurtailedSurplusKw?: () => number;
  public recordCurtailmentSample?: (netW: number, generationW: number | undefined, nowMs: number) => void;
  public canContributeCurtailmentSurplus?: () => boolean;
  // Whether the solar-surplus pool can ever open. The Main tracker observes
  // into its persisted export latch, so resetting or pruning usage history
  // cannot unmake the answer. The curtailment half is absent only until the
  // post-startup wiring assigns it — false until then, and the estimator
  // persists its own latch, so this is a boot window.
  private readonly surplusPoolReachability = AppPowerTracker.createSurplusPoolReachability(
    this.homey.settings,
    () => this.canContributeCurtailmentSurplus?.() === true,
  );
  public isSurplusPoolReachable = (): boolean => this.surplusPoolReachability.isReachable();
  public defaultComputeDynamicSoftLimit: (() => number | null) | undefined = undefined;
  public lastKnownPowerKw: LearnedPeaksByDeviceId = {};
  public expectedPowerKwOverrides: DeviceExpectedPowerOverrides = {};
  protected overheadToken?: Homey.FlowToken;
  public lastNotifiedOperatingMode = 'Home';
  private readonly settingsRepository = new SettingsRepository(this.homey);
  // Declared before every field that arms a timer. It depends on nothing, and
  // a field initializer that reaches it must run after this line — TypeScript
  // rejects the forward read rather than handing over an `undefined` registry.
  public readonly timers = new TimerRegistry();
  /** When the main home re-reads its capacity block and whether the read rebuilds (`lib/power`). */
  protected readonly capacitySettingsReloader = createCapacitySettingsReloader({
    store: this.capacitySettingsStore,
    timers: this.timers,
    timerKey: 'capacitySettingsLoadRetry',
    isStopped: () => false,
    install: (read) => this.installCapacitySettingsRead(read),
    // The main home's settings handlers rebuild after their own reload; only a
    // read that recovers on the retry lane rebuilds here.
    rebuildOnChange: false,
    rebuild: () => this.rebuildAfterCapacitySettingsRecovered(),
  });
  /**
   * The main home's rebuild loop, built by the factory every meter area builds
   * its own with. Its four components — throttle, scheduler, due-time policy
   * and scheduler telemetry — used to be four fields here, and an area had a
   * hand-rolled copy of two of them.
   */
  private readonly rebuildRuntime = createHomeRebuildRuntime(
    MAIN_HOME_ID,
    this.timers,
    // Main's timer namespace is the bare suffix, as it is for its settings keys.
    (suffix) => suffix,
    () => this.capacityGuard,
    () => this.planService,
    () => this.getStructuredLogger('plan'),
    (topic) => this.debugLoggingTopics.has(topic),
  );
  protected readonly planRebuildScheduler: PlanRebuildScheduler = this.rebuildRuntime.scheduler;
  public readonly planRebuildThrottle: PlanRebuildThrottle = this.rebuildRuntime.throttle;
  public readonly meterSilenceMonitor = createMeterSilenceMonitor({
    homeId: MAIN_HOME_ID,
    getPowerTracker: () => this.powerTracker,
    nowMs: () => Date.now(),
    structuredLog: () => this.getStructuredLogger('power'),
  });

  protected readonly powerSamplePipeline = createHomePowerPipeline({
    ctx: this,
    homeId: MAIN_HOME_ID,
    planRebuildThrottle: this.planRebuildThrottle,
    getPlanEngine: () => this.planEngine,
    getPlanService: () => this.planService,
    // The Main home's capacity state, named the same way a meter area names its
    // own. These reads are ambient on the app context, which is why the factory
    // used to default to them; the pipeline is a per-home component either way,
    // so the home it serves says where its state lives.
    getPowerTracker: () => this.powerTracker,
    getCapacitySettings: () => this.capacitySettings,
    getCapacityGuard: () => this.capacityGuard,
    // Main's meter IS the whole-home meter, so Main is the home that feeds
    // membership's sampled-meter ownership fence. Lazy: membership is wired
    // after the pipeline.
    noteResolvedHomeMeter: (deviceId, sampleAtMs) => (
      this.runtime.homeMembershipService?.noteResolvedHomeMeter(deviceId, sampleAtMs)
    ),
    savePowerTracker: (state) => this.savePowerTracker(state),
    getOutdoorTemperatureC: () => this.runtime.backgroundCollectors?.weatherCollector.getCurrentOutdoorTemperatureC(),
    recordPvGenerationSample: (genW, nowMs, netW) => (
      this.runtime.backgroundCollectors?.pvForecast.recordSample(genW, nowMs, netW)
    ),
    // Optional AppContext member assigned by wireCurtailmentSurplus post-startup;
    // main-home tap only (sub-home pipelines omit it — see the pipeline factory).
    recordCurtailmentSample: (netW, genW, nowMs) => this.recordCurtailmentSample?.(netW, genW, nowMs),
    // Production for samples that do not carry their own; the factory bounds its
    // freshness. Main home only — a sub-home must not adopt this production.
    observedHomePower: this.observedHomePower,
  });
  // Replaced by `startPostStartupBackgroundTasks` with a read of the live
  // source selector. Until then the seam still answers — `unknown` is the
  // status union's own member for "no provenance to report yet".
  public getPvForecastSourceUiStatus: () => PvForecastSourceUiStatus = () => ({ kind: 'unknown' });

  // Whether the owner's Homey price setup can be read — the settings UI's only
  // account of why a Homey-priced home shows no prices. Replaced when the price
  // coordinator is wired; `unknown` until then is the union's own member for
  // "nothing to report yet".
  public getHomeyPriceFormulaUiStatus: () => HomeyPriceFormulaUiStatus = () => ({ kind: 'unknown' });

  // What the Power by the Hour app answered when PELS last asked it for prices.
  // Replaced when the price coordinator is wired; `unknown` until then is the
  // union's own member for "PELS has not asked the app yet".
  public getPowerhourSourceUiStatus: () => PowerhourSourceUiStatus = () => ({ kind: 'unknown' });

  // The payload-fed price sources' stored days and currencies, which live in the
  // userdata price cache. Replaced when the price coordinator is wired; nothing
  // stored until then.
  public getPriceSourcePayloadsForUi: () => SettingsUiPriceSourcePayloads = () => ({
    flowToday: null,
    flowTomorrow: null,
    homeyCurrency: null,
    homeyToday: null,
    homeyTomorrow: null,
    powerhourCurrency: null,
    powerhourToday: null,
    powerhourTomorrow: null,
  });

  // The stored combined prices, for the settings UI and the plan widget.
  // Replaced when the price coordinator is wired; nothing stored until then.
  public getCombinedPricesForUi: () => unknown = () => null;

  private readonly backgroundTaskBundle: BackgroundTasks = createBackgroundTasks(this.context);

  // The composition root holds both halves — the controller the wiring drives,
  // and (on the bundle) the registry the started tasks' stop callbacks live in,
  // so that state has an owner outside `setup/` rather than sitting one property
  // deep inside the class that drives it.
  protected readonly backgroundTasks = this.backgroundTaskBundle.controller;

  /**
   * The userdata database and the stores on it that later boot steps reach
   * for (the trackers', and the power calibration the device transport feeds
   * from its first observation): opened at the first boot step, closed last at
   * teardown, and absent outside that window — a caller outside it gets an
   * error, never a lazily opened file nothing would close. The calibration
   * store alone stays after the close: its snapshot is held in memory, a late
   * plan read still gets it, and a late write fails and is said. The handles
   * live here because this is the composition root; each repository is built
   * by its own domain's wiring, so no one file composes two domains to hand
   * them out.
   */
  private userdataDatabase?: UserdataDatabase;
  private trackerStore?: TrackerStore;
  private powerCalibrationStore?: PowerCalibrationStore;
  private nativeFlowConflictStore?: AcceptedFlowConflictSlice<NativeFlowConflicts>;
  private chargingFlowWritesStore?: AcceptedFlowConflictSlice<FlowCapabilityWrites>;
  private openUserdata(): void {
    // The database first: the repositories are built on the one this holds.
    this.userdataDatabase = this.openUserdataDatabase();
    this.trackerStore = createTrackerStoreForApp(this.ctx);
    this.powerCalibrationStore = createPowerCalibrationStoreForApp(this.ctx);
    this.nativeFlowConflictStore = createNativeFlowConflictStore(this.userdataDatabase);
    this.chargingFlowWritesStore = createChargingFlowWritesStore(this.userdataDatabase);
    // Before the transport's first parse, so a known conflict holds built-in control back from boot.
    this.builtInControlFlowConflicts.restoreSaved();
  }
  private opened<T>(handle: T | undefined): T {
    if (handle === undefined) throw new Error('the userdata database is not open');
    return handle;
  }
  public getTrackerStore(): TrackerStore {
    return this.opened(this.trackerStore);
  }
  public getPowerCalibrationStore(): PowerCalibrationStore {
    return this.opened(this.powerCalibrationStore);
  }
  public getChargingFlowWritesStore(): AcceptedFlowConflictSlice<FlowCapabilityWrites> {
    return whileDatabaseOpen(() => this.chargingFlowWritesStore);
  }
  public getUserdataDatabase(): UserdataDatabase {
    return this.opened(this.userdataDatabase);
  }
  private closeUserdataDatabase(): void {
    this.userdataDatabase?.close();
    this.userdataDatabase = undefined;
    this.trackerStore = undefined;
    this.nativeFlowConflictStore = undefined;
    this.chargingFlowWritesStore = undefined;
  }
  /**
   * The Main home's power tracker: the same classified persistence component
   * every meter area runs, on the unsuffixed key (`homeScopedSettingsKey` is
   * the identity for `'main'`) and unbound from any one meter — the Main-meter
   * authority governs which meter its samples come from.
   */
  public readonly mainTracker = AppPowerTracker.createMainTracker({
    getStore: () => this.getTrackerStore(),
    timers: this.timers,
    getLogger: () => this.getStructuredLogger('power'),
    reportError: (message, error) => this.error(message, error),
    getTimeZone: () => this.getTimeZone(),
    isTornDown: () => this.shutdown.isStopped(),
    onPersisted: () => this.emitPowerTrackerPersisted(MAIN_HOME_ID),
    // Main's feed is the whole-home feed the surplus pool is measured on.
    observeExportEvidence: (state) => this.surplusPoolReachability.observeExportEvidence(state),
  });

  private readonly targetPowerReachabilityWiring = createTargetPowerReachabilityAppWiring(this);
  public readonly snapshotHelpers: AppSnapshotHelpers = new AppSnapshotHelpers({
    getPowerSource: () => this.getPowerSource(),
    timers: this.timers,
    getDeviceManager: () => this.deviceManager,
    getPlanEngine: () => this.planEngine,
    getPlanService: () => this.planService,
    getPlanInputSnapshot: () => this.getPlanInputSnapshot(),
    getDeviceSurfaces: () => this.getDeviceSurfaces(),
    resolveManagedState: (deviceId) => this.resolveManagedState(deviceId),
    isCapacityControlEnabled: (deviceId) => this.isCapacityControlEnabled(deviceId),
    getStructuredLogger: (component) => this.getStructuredLogger(component),
    getNow: () => this.getNow(),
    logPeriodicStatus: (options) => this.logPeriodicStatus(options),
    persistFilledModeTargets: () => this.modeDeviceTargetFill.persist(),
    getFlowReportedDeviceIds: () => this.flowBacked.getFlowReportedDeviceIds(),
    emitFlowBackedRefreshRequests: async (deviceIds) => this.flowBacked.emitFlowBackedRefreshRequests(deviceIds),
    emitSettingsUiDevicesUpdated: () => this.emitSettingsUiDevicesUpdated(),
    recordPowerSample: (sample) => this.powerSamplePipeline.recordPowerSample(sample.powerW, undefined, sample),
    resolveMainMeterSelection: () => this.settingsRepository.loadMainMeterSelection(),
    readMainMeter: resolveMainMeterRead,
    ...this.targetPowerReachabilityWiring.snapshotDeps,
  });
  public readonly homeyEnergyHelpers = createHomeyEnergyPollSource(this, this.powerSamplePipeline);
  public readonly generationPollSource = createGenerationPollSource(this, this.observedHomePower);
  /**
   * The executor's commanded axis for stepped loads. Constructed here because
   * `app.ts` is the composition root and this store outlives every home's plan
   * engine; device ids are globally unique, so one app-wide store serves them
   * all. It is handed to the wiring that drives it and to the plan engine that
   * owns it — `lib/executor/steppedCommandStore.ts`.
   */
  private readonly steppedStores: SteppedStores = createSteppedStores();

  public readonly steppedCommandStore = this.steppedStores.commandStore;

  public readonly steppedReportedStore = this.steppedStores.reportedStore;
  public readonly deviceControlHelpers = createDeviceControlHelpers(
    this, this.targetPowerReachabilityWiring.updateTargetPowerReachability,
    (dueAtMs) => this.snapshotHelpers.scheduleTargetPowerProbeSettlement(dueAtMs),
  );
  public readonly flowBacked = createFlowBackedDeviceState(this.homey, {
    persistence: this.settingsRepository,
    getStructuredLogger: (component) => this.getStructuredLogger(component),
    getFlowReportedCapabilities: () => this.flowReportedCapabilities,
    setFlowReportedCapabilities: (state) => { this.flowReportedCapabilities = state; },
    getDeviceManager: () => this.deviceManager,
    getDeviceConfiguration: () => this.deviceConfiguration.getAll(),
    resolveManagedState: (deviceId) => this.resolveManagedState(deviceId),
    getSteppedLoadProfile: (deviceId) => this.deviceControlHelpers.getSteppedLoadProfile(deviceId),
    getExpectedPowerKwOverrides: () => this.expectedPowerKwOverrides,
    getLearnedPowerPeaks: () => this.lastKnownPowerKw,
    timers: this.timers,
    syncHeadroomUsageObservation: (deviceId, kw) => { this.planService.syncHeadroomUsageObservation(deviceId, kw); },
  });
  public readonly builtInControlFlowConflicts = new BuiltInControlFlowConflicts(
    this.shutdown,
    whileDatabaseOpen(() => this.nativeFlowConflictStore),
    this.deviceControlSettings,
    () => this.getDeviceDescriptors(),
    () => this.deviceManager.chargingCurrentControl,
    {
      awaitSnapshotWarmup: async () => { await this.snapshotWarmupGate?.wait(); },
      refreshSnapshot: () => this.refreshTargetDevicesSnapshot(),
      rebuildPlan: () => this.planService.rebuildPlanFromCache('native_wiring_auto_decision'),
    },
  );
  protected readonly powerTrackerHelpers = new AppPowerTracker({
    homey: this.homey,
    timers: this.timers,
    getTracker: () => this.mainTracker,
    getPowerCalibrationStore: () => this.getPowerCalibrationStore(),
    getDailyBudgetService: () => this.dailyBudgetService,
    error: (...args) => this.error(...args),
    updateDailyBudgetAndRecordCap: (options) => this.updateDailyBudgetAndRecordCap(options),
  });
  private readonly ctx = this.context;
  protected readonly smartTaskPayloads = new AppSmartTaskPayloads(this.ctx);
  // The snapshot refresh's mode-target fill pass, built once so the entries it
  // already filled are remembered for the life of the process. Declared after
  // `ctx`, which it reads at construction; the snapshot helpers above only call
  // it once the app is running.
  private readonly modeDeviceTargetFill = createModeDeviceTargetFill(this.ctx);
  // The settings UI's per-home read: a closure over the registry handle, so the
  // registry itself never reaches the context.
  public readonly homeRuntimeRead = buildHomeRuntimeReadPort(() => this.runtime.homeRuntimeRegistry);
  /** The sub-homes' meters for the whole-home poll (`HomeMeters`), once the registry exists. */
  getSubHomeMeters(): SubHomeMeters | undefined {
    return this.runtime.homeRuntimeRegistry;
  }

  // Boot/teardown orchestration + per-service construction.
  protected readonly serviceWiring = new AppServiceWiring({
    ctx: this.ctx,
    getHomeOperatingMode: this.getHomeOperatingMode,
    getPrioritiesForDevices: (deviceIds) => this.homeModeCatalog.getPrioritiesForDevices(deviceIds),
    getModeDeviceTargets: () => this.homeModeCatalog.getModeDeviceTargets(),
    resolveOperatingModeForDevice: (deviceId) => this.homeModeCatalog.resolveOperatingModeForDevice(deviceId),
    createHomeRuntimeRegistry: (membership) => createHomeRuntimeRegistryForApp(
      this.ctx,
      this.homeModeCatalog,
      membership,
    ),
    handles: this.runtime,
    shutdown: this.shutdown,
    teardown: this.backgroundTaskBundle.teardown,
    mainPowerSamplePipeline: this.powerSamplePipeline,
    homeyApp: this,
    backgroundTasks: this.backgroundTasks,
    timers: this.timers,
    powerTrackerHelpers: this.powerTrackerHelpers,
    planRebuildScheduler: this.planRebuildScheduler,
    observedStateEmitter: this.observedStateEmitter,
    observedHomePower: this.observedHomePower,
    observedDeviceStateProjection: this.observer,
    openUserdataStores: () => this.openUserdata(),
    reloadMainModeCatalog: () => this.homeModeCatalog.reload(),
    closeUserdataDatabase: () => this.closeUserdataDatabase(),
  });
  // Smart-task (deferred-objective) preview/create/cancel/rescue + history
  // payload bodies. Declared after `serviceWiring`, which builds the main
  // home's evaluation source the preview shares with the live lanes.
  protected readonly smartTaskApi = new AppSmartTaskApi(this.ctx, this.serviceWiring.taskEvaluationSource);

  public readonly observedTemperatureModeUpdates = this.serviceWiring.createObservedTemperatureModeUpdates();
}

export = PelsApp;
