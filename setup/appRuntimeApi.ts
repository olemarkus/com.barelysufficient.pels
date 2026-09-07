import { emitPowerTrackerPersistedForApp } from './settingsUiAppRuntime';
import { importLegacyPowerTrackers } from '../lib/power/trackerLegacySettings';
import { importLegacyWeatherHistory } from '../lib/weather/weatherHistoryStore';
import { openUserdataStores, type AppUserdataStores } from './userdataStores';
import type { AppContext, FlowBackedCapabilityReportOutcome } from '../lib/app/appContext';
import type Homey from 'homey';
import type { PowerCalibrationSnapshot } from '../packages/contracts/src/powerCalibration';
import type {
  EvChargingState,
  ObservedDeviceState,
  ProjectedObservedDeviceState,
  TargetDeviceSnapshot,
} from '../packages/contracts/src/types';
import {
  readObservedEvChargingState,
  readObservedStateOfCharge,
  readObservedTemperatureState,
} from '../lib/observer/observedDeviceStateProjection';
import type {
  ObservedStateOfChargeRead,
  ObservedTemperatureRead,
} from '../lib/observer/observedDeviceStateProjection';
import type { HomeyDeviceLike } from '../lib/utils/types';
import type { DebugLoggingTopic } from '../packages/shared-domain/src/utils/debugLogging';
import { getDebugEmitter, getDebugTopics, setDebugTopics } from '../lib/logging/logger';
import type { StructuredDebugEmitter, Logger as PinoLogger } from '../lib/logging/logger';
import type { DevicePlan, PendingTargetObservationSource } from '../lib/plan/planTypes';
import type { PlanService } from '../lib/plan/planService';
import type { DailyBudgetUpdateStateOptions } from '../lib/dailyBudget/dailyBudgetTypes';
import {
  updateDailyBudgetAndRecordCapForApp,
} from '../lib/power/sampleIngest';
import type {
  FlowReportedCapabilityId,
  FlowReportedCapabilitiesByDevice,
  FlowReportedCapabilitiesForDevice,
} from '../lib/device/transport/flowReportedCapabilities';
import {
  getFlowReportedDeviceIds,
  readFlowReportedCapabilitiesForDevice,
} from '../lib/device/transport/flowReportedCapabilities';
import { buildDebugLoggingTopics } from '../lib/utils/debugLoggingSettings';
import { normalizeStoredDeviceControlProfiles } from './appDeviceControlHelpers';
import { normalizeError } from '../lib/utils/errorUtils';
import { logHomeyDeviceComparisonForDebugFromApp } from './appDebugHelpers';
import {
  isTemperatureControlDisabledForApp,
  loadCapacitySettingsFromHomey,
  loadTemperatureControlPolicySettingsForApp,
} from './appSettingsHelpers';
import { migrateManagedDevices } from './appManagedDeviceMigration';
import type { TimerRegistry } from '../lib/utils/timerRegistry';
import { runBootMigrations } from './appBootMigrations';
import { registerAppFlowCards, toObservedStateSeed } from './appInit';
import { buildPeriodicStatusLogFields } from '../lib/diagnostics/periodicStatus';
import type { FlowBackedDeviceState } from '../lib/device/flowBackedDeviceState';
import type { BackgroundTasksController } from './backgroundTasksController';
import type { AppNativeWiring } from './appNativeWiring';
import type { AppPowerTracker } from './appPowerTracker';
import type { AppServiceWiring } from './appServiceWiring';
import type { PowerCalibrationStore } from '../lib/device/devicePowerCalibrationStore';
import type { ObservedDeviceStateProjection } from '../lib/observer/observedDeviceStateProjection';
import type { PowerSamplePipeline } from './powerSamplePipeline';
import type { PlanRebuildScheduler } from '../lib/plan/rebuildScheduler/scheduler';
import { withAppHostApi } from './appHostApi';

/** Lifecycle and runtime adapter façade above the stable host/UI surface. */
// The callback body is one class declaration; class/file line caps still apply.
// eslint-disable-next-line max-lines-per-function
export const withAppRuntimeApi = (Base: ReturnType<typeof withAppHostApi>) => {
abstract class AppRuntimeApi extends Base {
  protected abstract readonly flowBacked: FlowBackedDeviceState;
  protected abstract readonly timers: TimerRegistry;
  protected abstract flowReportedCapabilities: FlowReportedCapabilitiesByDevice;
  protected abstract readonly backgroundTasks: BackgroundTasksController;
  protected abstract readonly powerSamplePipeline: PowerSamplePipeline;
  protected abstract readonly planRebuildScheduler: PlanRebuildScheduler;
  protected abstract observedDeviceStateProjection: ObservedDeviceStateProjection;
  protected abstract powerCalibrationStore: PowerCalibrationStore;
  protected abstract readonly serviceWiring: AppServiceWiring;
  protected abstract readonly nativeWiring: AppNativeWiring;
  protected abstract readonly powerTrackerHelpers: AppPowerTracker;
  protected abstract structuredLogger?: PinoLogger;
  protected abstract overheadToken?: Homey.FlowToken;
  protected abstract nativeEvWiringDevices: Record<string, boolean>;

  public setExpectedOverride(deviceId: string, kw: number): boolean {
    return this.flowBacked.setExpectedOverride(deviceId, kw);
  }
  public reloadExpectedPowerOverrides = (): void => this.flowBacked.reloadExpectedPowerOverrides();
  public getFlowReportedCapabilitiesForDevice = (deviceId: string): FlowReportedCapabilitiesForDevice => (
    readFlowReportedCapabilitiesForDevice(this.flowReportedCapabilities, deviceId)
  );
  public getFlowReportedDeviceIds = (): string[] => getFlowReportedDeviceIds(this.flowReportedCapabilities);
  public reportFlowBackedCapability(params: {
    deviceId: string; capabilityId: FlowReportedCapabilityId; value: boolean | number | string; reportedAt?: number;
  }): FlowBackedCapabilityReportOutcome {
    return this.flowBacked.reportFlowBackedCapability(params);
  }
  public async getHomeyDevicesForFlow(): Promise<HomeyDeviceLike[]> {
    return this.flowBacked.getHomeyDevicesForFlow();
  }
  public async emitFlowBackedRefreshRequests(deviceIds: string[]): Promise<void> {
    return this.flowBacked.emitFlowBackedRefreshRequests(deviceIds);
  }
  public reloadWeatherCollector(): void {
    this.backgroundTasks.startWeatherCollector(this.weatherCollector);
  }
  public recordPowerSample(powerW: number, nowMs?: number): ReturnType<AppContext['recordPowerSample']> {
    return this.powerSamplePipeline.recordPowerSample(powerW, nowMs);
  }
  public loadDailyBudgetSettings(): void {
    this.requireDailyBudgetService().loadSettings();
  }
  public updateDailyBudgetState(options?: DailyBudgetUpdateStateOptions): void {
    this.updateDailyBudgetAndRecordCap(options);
  }
  public requestFlowPlanRebuild(source: string): void {
    this.planRebuildScheduler.request({ kind: 'flow', reason: 'flow_card', detail: source });
  }
  public getObservationRevision(): number {
    return this.observedDeviceStateProjection.getRevision();
  }

  /**
   * The general observed read: the base state, and no observed cluster.
   *
   * Declared narrow on purpose. The projection physically stores every cluster
   * — state of charge, temperature, EV plug-state, measured power, reported step
   * — and while this handed out `ProjectedObservedDeviceState`, every consumer
   * wired to it could read any of them raw, bypassing the named reads that
   * RESOLVE them. `observed.stateOfCharge.report.percent` is now a compile error
   * here; a caller that wants a cluster asks for it by name and gets a semantic
   * result (`readObservedStateOfCharge`, `readObservedTemperatureState`).
   *
   * Because every cluster field is optional, the narrow type is still
   * structurally assignable to the wide one — so this does not break the one
   * consumer that legitimately needs the whole record, which asks for it below.
   */
  public getObservedState(deviceId: string): ObservedDeviceState | undefined {
    return this.observedDeviceStateProjection.getObservedState(deviceId);
  }

  /**
   * The whole observed record, for the consumers that HOLD it rather than ask a
   * question of it. There are exactly two, and they are worth naming:
   *
   * - the settings-UI payload refresh, which overlays a fixed list of
   *   raw-observed fields onto the served device (`LIVE_OBSERVED_FIELDS`);
   * - the executor's drift check, which reads the reported step, measured power
   *   and EV state together to decide whether the device has moved off plan
   *   (`ObserverDeviceRead`, `lib/executor/driftObservedDevice.ts`).
   *
   * Separate from `getObservedState` and named for what it is, so holding the
   * record stays a deliberate choice. Before this split the drift path took the
   * base-typed read and structurally widened it, which compiled and worked only
   * because the object underneath was physically wider than its type — so a
   * `getObservedState` that ever returned a genuinely narrowed copy would have
   * changed drift decisions with no type error anywhere.
   *
   * A third caller is the general exit re-opening. Anything wanting one cluster
   * wants a named read.
   */
  public getObservedRecord(deviceId: string): ProjectedObservedDeviceState | undefined {
    return this.observedDeviceStateProjection.getObservedState(deviceId);
  }

  /**
   * The named cluster reads. One accessor per observed fact, each returning what
   * the observer RESOLVED rather than the record it resolved from — so the
   * question "what is this device's charge" has exactly one answer and exactly
   * one way to ask it.
   *
   * They read the projection directly rather than being handed a value from
   * `getObservedState`, which no longer declares the clusters. Passing one across
   * would compile (every cluster field is optional, so the narrow type is
   * assignable to the wide one) and would work only because the object underneath
   * is physically wider than its type — which is the kind of accident that
   * survives until someone returns a genuinely narrowed copy.
   */
  public getObservedStateOfCharge(deviceId: string): ObservedStateOfChargeRead {
    return readObservedStateOfCharge(this.observedDeviceStateProjection.getObservedState(deviceId));
  }

  public getObservedTemperature(deviceId: string): ObservedTemperatureRead {
    return readObservedTemperatureState(this.observedDeviceStateProjection.getObservedState(deviceId));
  }

  /**
   * Still `| undefined` rather than a semantic result: unlike its two siblings,
   * the EV plug-state read has not been converted yet. Same defect, separate
   * fact — it is the next one.
   */
  public getObservedEvChargingState(deviceId: string): EvChargingState | undefined {
    return readObservedEvChargingState(this.observedDeviceStateProjection.getObservedState(deviceId));
  }
  public seedObservedStateFromSnapshot(): void {
    this.observedDeviceStateProjection.seedMissing(toObservedStateSeed(this.context.deviceManager?.getSnapshot()));
  }
  public async logTargetRetryComparison(params: {
    deviceId: string; name: string; target: 'temperature'; desired: number; observedValue?: unknown;
    observedSource?: string; retryCount: number; skipContext: 'plan' | 'shedding' | 'overshoot';
  }): Promise<void> {
    await logHomeyDeviceComparisonForDebugFromApp({
      app: this,
      deviceId: params.deviceId,
      reason: `target_retry:${params.skipContext}:${params.target}`,
      expectedTarget: params.desired,
      observedTarget: params.observedValue,
      observedSource: params.observedSource,
    });
  }
  public syncLivePlanStateAfterTargetActuation(source: PendingTargetObservationSource): boolean | void {
    return this.requirePlanService().syncLivePlanStateInline(source);
  }
  // Protected compatibility seams for integration coverage of plan execution.
  // Production control enters through PlanService rebuilds, not the host API.
  protected applyPlanActions = (plan: DevicePlan) => this.requirePlanService().applyPlanActions(plan);
  protected applySheddingToDevice = (deviceId: string, deviceName: string, reason?: string) => (
    this.requirePlanService().applySheddingToDevice(deviceId, deviceName, reason)
  );
  public evaluateHeadroomForDevice(
    params: Parameters<PlanService['evaluateHeadroomForDevice']>[0],
  ) {
    return this.requirePlanService().evaluateHeadroomForDevice(params);
  }
  public getPowerCalibrationSnapshot(): PowerCalibrationSnapshot {
    return this.powerCalibrationStore.getSnapshot();
  }
  public async onInit(): Promise<void> { await this.serviceWiring.runInit(); }
  protected runNativeWiringDetectionBestEffort(): void { this.nativeWiring.runNativeWiringDetectionBestEffort(); }
  protected delayMs(ms: number): Promise<void> { return this.nativeWiring.delayMs(ms); }
  protected resolveNativeWiringEnabled(deviceId: string): boolean {
    return this.nativeWiring.resolveNativeWiringEnabled(deviceId);
  }
  protected applyNativeWiringAutoDecisions(): Promise<void> {
    return this.nativeWiring.applyNativeWiringAutoDecisions();
  }
  protected initPriceCoordinator(): Promise<void> { return this.serviceWiring.initPriceCoordinator(); }
  protected initDailyBudgetService(): void { this.serviceWiring.initDailyBudgetService(); }
  protected initDeviceManager(): Promise<void> { return this.serviceWiring.initDeviceManager(); }
  protected getSnapshotDevice(deviceId: string): TargetDeviceSnapshot | undefined {
    return this.context.deviceManager?.getSnapshot()?.find((entry) => entry.id === deviceId);
  }
  protected hasEnabledEvBoostForSnapshot(device: TargetDeviceSnapshot | undefined): boolean {
    if (!device || device.deviceClass !== 'evcharger') return false;
    const config = this.getEvBoostConfig(device.id);
    return config?.enabled === true && Number.isFinite(config.boostBelowPercent);
  }
  protected initCapacityGuard(): void { this.serviceWiring.initCapacityGuard(); }
  protected initPlanEngine(): void { this.serviceWiring.initPlanEngine(); }
  protected initDeviceDiagnosticsService(): void { this.serviceWiring.initDeviceDiagnosticsService(); }
  protected initPlanService(): void { this.serviceWiring.initPlanService(); }
  protected subscribePlanObservedState(): void { this.serviceWiring.subscribePlanObservedState(); }
  protected getPlanRebuildNowMs(): number { return this.planRebuildScheduler.now().nowMs; }
  protected captureDefaultDynamicSoftLimit(): void { this.serviceWiring.captureDefaultDynamicSoftLimit(); }
  protected initSettingsHandler(): void { this.serviceWiring.initSettingsHandler(); }
  public async onUninit(): Promise<void> { await this.serviceWiring.runUninit(); }
  public logDebug(topic: DebugLoggingTopic, ...args: unknown[]): void {
    if (this.context.debugLoggingTopics.has(topic)) this.log(...args);
  }
  public getStructuredLogger(component: string): PinoLogger | undefined {
    return this.structuredLogger?.child({ component });
  }
  public getApiStructuredLogger(): PinoLogger | undefined { return this.getStructuredLogger('api'); }
  /**
   * The wiring-side name for {@link getDebugEmitter}. Callers that still take a
   * threaded `debugStructured` are handed one from here; a caller that resolves
   * its own emitter should reach for `getDebugEmitter` directly. Both are the
   * same emitter, so a file migrating off the parameter changes nothing about
   * what it emits.
   */
  public getStructuredDebugEmitter(component: string, debugTopic: DebugLoggingTopic): StructuredDebugEmitter {
    return getDebugEmitter(component, debugTopic);
  }
  public getDynamicSoftLimitOverride(): number | null {
    if (
      !this.context.defaultComputeDynamicSoftLimit
      || this.computeDynamicSoftLimit === this.context.defaultComputeDynamicSoftLimit
    ) {
      return null;
    }
    const value = this.computeDynamicSoftLimit();
    return Number.isFinite(value) ? value : null;
  }
  public updatePriceOptimizationEnabled = (logChange = false): void => {
    this.requirePriceCoordinator().updatePriceOptimizationEnabled(logChange);
  };
  public get priceOptimizationEnabled(): boolean {
    return this.requirePriceCoordinator().getPriceOptimizationEnabled();
  }
  public get priceOptimizationSettings() {
    return this.requirePriceCoordinator().getPriceOptimizationSettings();
  }
  /**
   * The enabled debug topics, delegating to the process-wide set rather than
   * holding a second copy of it. The debug emitters gate on that set, and
   * several consumers close over `debugLoggingTopics.has(topic)` to decide
   * whether to BUILD a debug payload — the scheduler telemetry observer,
   * background tasks, and the plan/overview/diagnostics/daily-budget
   * predicates. A second copy would let those readers say yes while the
   * emitter's gate said no: the payload built, the line dropped.
   */
  public get debugLoggingTopics(): Set<DebugLoggingTopic> { return getDebugTopics(); }

  public set debugLoggingTopics(value: Set<DebugLoggingTopic>) { setDebugTopics(value); }

  public updateDebugLoggingEnabled = (logChange = false): void => {
    // One write: the context accessor publishes process-wide, so the emitters
    // and every `debugLoggingTopics.has(...)` closure read the same set.
    this.context.debugLoggingTopics = buildDebugLoggingTopics({ settings: this.homey.settings, logChange });
  };
  public notifyOperatingModeChanged(mode: string): void {
    const trimmed = mode.trim();
    if (!trimmed || this.context.lastNotifiedOperatingMode === trimmed) return;
    const card = this.homey.flow?.getTriggerCard?.('operating_mode_changed');
    if (card && typeof card.trigger === 'function') {
      card.trigger({}, { mode: trimmed }).catch((err: Error) => this.getStructuredLogger('flow')
        ?.error({ event: 'operating_mode_changed_trigger_failed', err: normalizeError(err) }));
    }
    this.context.lastNotifiedOperatingMode = trimmed;
  }
  public hydratePowerTracker(): void {
    this.powerTrackerHelpers.hydratePowerTracker();
  }
  /**
   * The app's userdata stores, opened at its first boot step. The test
   * harness overrides this to open one database per spec file.
   */
  protected openUserdataStores(): AppUserdataStores {
    return openUserdataStores();
  }
  public emitPowerTrackerPersisted(homeId: string): void {
    emitPowerTrackerPersistedForApp(this.homey, homeId, (message, error) => this.error(message, error));
  }
  protected loadPowerCalibrationStore(): void { this.powerTrackerHelpers.loadPowerCalibrationStore(); }
  protected persistPowerCalibrationIfDue(nowMs: number = Date.now()): void {
    this.powerTrackerHelpers.persistPowerCalibrationIfDue(nowMs);
  }
  protected flushPowerCalibration(nowMs: number = Date.now()): void {
    this.powerTrackerHelpers.flushPowerCalibration(nowMs);
  }
  protected runStartupSettingsMigrations(): void {
    migrateManagedDevices({ homey: this.homey });
    runBootMigrations({ homey: this.homey });
    // The store opened at the first boot step; the trackers hydrate from it later.
    importLegacyPowerTrackers(this.homey.settings, this.context.getTrackerStore());
    importLegacyWeatherHistory(this.homey.settings, this.context.getWeatherHistoryStore());
  }
  public areFlowBackedCardsAvailable(): boolean { return this.flowBacked.areFlowBackedCardsAvailable(); }
  public loadCapacitySettings = (): void => {
    const next = loadCapacitySettingsFromHomey({
      settings: this.homey.settings,
      current: {
        capacitySettings: this.context.capacitySettings,
        modeAliases: this.context.modeAliases,
        operatingMode: this.context.operatingMode,
        capacityPriorities: this.context.capacityPriorities,
        modeDeviceTargets: this.context.modeDeviceTargets,
        capacityDryRun: this.context.capacityDryRun,
        controllableDevices: this.context.controllableDevices,
        managedDevices: this.context.managedDevices,
        budgetExemptDevices: this.context.budgetExemptDevices,
        temperatureControlDisabledDevices: this.context.temperatureControlDisabledDevices,
        temperatureControlPolicyState: this.context.temperatureControlPolicyState,
        temperatureBoostSettings: this.context.temperatureBoostSettings,
        evBoostSettings: this.context.evBoostSettings,
        evCarAssociations: this.context.evCarAssociations,
        nativeEvWiringDevices: this.nativeEvWiringDevices,
        deviceDriverOverrides: this.context.deviceDriverOverrides,
        deviceControlProfiles: this.context.deviceControlProfiles,
        deviceTargetPowerConfigs: this.context.deviceTargetPowerConfigs,
        shedBehaviors: this.context.shedBehaviors,
      },
    });
    Object.assign(this.context, next, {
      deviceControlProfiles: normalizeStoredDeviceControlProfiles(next.deviceControlProfiles) ?? {},
    });
    this.updatePriceOptimizationEnabled();
    void this.updateOverheadToken(this.context.capacitySettings.marginKw);
  };
  public loadTemperatureControlPolicySettings = (): void => (
    loadTemperatureControlPolicySettingsForApp(this.context)
  );
  public loadPriceOptimizationSettings = (): void => {
    this.requirePriceCoordinator().loadPriceOptimizationSettings();
  };
  public updateOverheadToken = async (value?: number): Promise<void> => {
    const overhead = Number.isFinite(value) ? Number(value) : this.context.capacitySettings.marginKw;
    try {
      if (!this.overheadToken) {
        this.overheadToken = await this.homey.flow.createToken('capacity_overhead', {
          type: 'number', title: 'Soft margin (kW)', value: overhead ?? 0,
        });
      }
      await this.overheadToken.setValue(overhead ?? 0);
    } catch (error) {
      this.getStructuredLogger('flow')?.error({
        event: 'capacity_overhead_token_update_failed', err: normalizeError(error),
      });
    }
  };
  protected stopPowerTracker(): void { this.powerTrackerHelpers.stopPowerTracker(); }
  protected startPowerTrackerPruning(): void { this.powerTrackerHelpers.startPowerTrackerPruning(); }
  protected savePowerTracker(nextState: AppContext['powerTracker']): void {
    this.powerTrackerHelpers.savePowerTracker(nextState);
  }
  public replacePowerTrackerForUi(nextState: AppContext['powerTracker']): void {
    this.powerTrackerHelpers.replacePowerTrackerForUi(nextState);
  }
  protected updateDailyBudgetAndRecordCap(options?: DailyBudgetUpdateStateOptions): void {
    const dailyBudgetService = this.requireDailyBudgetService();
    this.context.powerTracker = updateDailyBudgetAndRecordCapForApp({
      powerTracker: this.context.powerTracker,
      dailyBudgetService,
      options,
    });
  }
  protected registerAppFlowCards(): void { registerAppFlowCards(this.context); }
  public isTemperatureControlDisabled = (deviceId: string): boolean => (
    isTemperatureControlDisabledForApp(this.context, deviceId)
  );
  protected logPeriodicStatus(options: { includeDeviceHealth?: boolean } = {}): void {
    if (!this.context.capacityGuard) throw new Error('CapacityGuard must be initialized');
    if (!this.context.planEngine) throw new Error('PlanEngine must be initialized');
    this.getStructuredLogger('status')?.info(buildPeriodicStatusLogFields({
      capacityGuard: this.context.capacityGuard,
      powerTracker: this.context.powerTracker,
      capacitySettings: this.context.capacitySettings,
      operatingMode: this.context.operatingMode,
      capacityDryRun: this.context.capacityDryRun,
      starvedDeviceCount: this.context.deviceDiagnosticsService?.getCurrentStarvedDeviceCount?.() ?? 0,
      capacityPaceKw: this.computeDynamicSoftLimit(),
      sheddingActive: this.context.planEngine.state.sheddingActive,
    }));
    if (options.includeDeviceHealth === true) {
      const deviceStatus = this.requireDeviceManager().getPeriodicStatusMetrics();
      if (deviceStatus) {
        this.getStructuredLogger('devices')?.info({ event: 'periodic_device_health_summary', ...deviceStatus });
      }
    }
    const dailyBudgetStatus = this.requireDailyBudgetService().getPeriodicStatusFields();
    if (dailyBudgetStatus) this.getStructuredLogger('daily_budget')?.info(dailyBudgetStatus);
  }
}

return AppRuntimeApi;
};

/** Compose both setup façades while keeping the Homey SDK value in `app.ts`. */
export const withAppApi = (Base: Parameters<typeof withAppHostApi>[0]) => (
  withAppRuntimeApi(withAppHostApi(Base))
);
