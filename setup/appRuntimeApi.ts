import type { AppContext, FlowBackedCapabilityReportOutcome } from '../lib/app/appContext';
import type Homey from 'homey';
import type { PowerCalibrationSnapshot } from '../packages/contracts/src/powerCalibration';
import type { ProjectedObservedDeviceState, TargetDeviceSnapshot } from '../packages/contracts/src/types';
import type { HomeyDeviceLike } from '../lib/utils/types';
import type { DebugLoggingTopic } from '../packages/shared-domain/src/utils/debugLogging';
import type { StructuredDebugEmitter, Logger as PinoLogger } from '../lib/logging/logger';
import type { DevicePlan, PendingTargetObservationSource } from '../lib/plan/planTypes';
import type { PlanService } from '../lib/plan/planService';
import type { DailyBudgetUpdateStateOptions } from '../lib/dailyBudget/dailyBudgetTypes';
import {
  updateDailyBudgetAndRecordCapForApp,
  type PowerTrackerPersistReason,
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
import { runBootMigrations } from './appBootMigrations';
import { registerAppFlowCards, toObservedStateSeed } from './appInit';
import { buildPeriodicStatusLogFields } from '../lib/diagnostics/periodicStatus';
import type { AppFlowBacked } from './appFlowBacked';
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
  protected abstract readonly flowBacked: AppFlowBacked;
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
    this.planRebuildScheduler.request({ kind: 'flow', reason: `flow_card:${source}` });
  }
  public getObservedState(deviceId: string): ProjectedObservedDeviceState | undefined {
    return this.observedDeviceStateProjection.getObservedState(deviceId);
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
  public getStructuredDebugEmitter(component: string, debugTopic: DebugLoggingTopic): StructuredDebugEmitter {
    return (payload) => {
      if (!this.structuredLogger || !this.context.debugLoggingTopics.has(debugTopic)) return;
      this.structuredLogger.child({ component }, { level: 'debug' }).debug({ ...payload, debugTopic });
    };
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
  public updateDebugLoggingEnabled = (logChange = false): void => {
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
  public loadPowerTracker(options: { skipDailyBudgetUpdate?: boolean } = {}): void {
    this.powerTrackerHelpers.loadPowerTracker(options);
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
        deviceCommunicationModels: this.context.deviceCommunicationModels,
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
  protected persistPowerTrackerState(reason: PowerTrackerPersistReason = 'write'): void {
    this.powerTrackerHelpers.persistPowerTrackerState(reason);
  }
  protected prunePowerTrackerHistory(): void { this.powerTrackerHelpers.prunePowerTrackerHistory(); }
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
