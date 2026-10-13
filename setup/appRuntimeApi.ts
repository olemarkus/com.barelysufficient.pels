import { temperaturePolicyPriceSettings } from '../packages/shared-domain/src/settings/temperatureControl';
import { emitPowerTrackerPersistedForApp, emitSettingsUiDevicesUpdatedForApp } from './settingsUiAppRuntime';
import { openAppUserdataDatabase, type UserdataDatabase } from '../lib/store/userdataDatabase';
import type { AppContext } from '../lib/app/appContext';
import type { FlowConflictRefreshResult } from '../lib/flowApi/flowConflictRefreshCoordinator';
import type Homey from 'homey';
import type { PowerCalibrationSnapshot } from '../packages/contracts/src/powerCalibration';
import type { DebugLoggingTopic } from '../packages/shared-domain/src/utils/debugLogging';
import { getDebugTopics, setDebugTopics } from '../lib/logging/logger';
import type { Logger as PinoLogger } from '../lib/logging/logger';
import type { PendingTargetObservationSource } from '../lib/plan/planTypes';
import type { PlanService } from '../lib/plan/planService';
import type { DailyBudgetUpdateStateOptions } from '../lib/dailyBudget/dailyBudgetTypes';
import {
  updateDailyBudgetAndRecordCapForApp,
} from '../lib/power/sampleIngest';
import {
  resolveInstalledCapacityScalars,
  type CapacityScalarSettingsRead,
  type CapacitySettingsReloader,
} from '../lib/power/capacitySettingsStore';
import { buildDebugLoggingTopics } from '../lib/utils/debugLoggingSettings';
import { normalizeError } from '../lib/utils/errorUtils';
import type { TimerRegistry } from '../lib/utils/timerRegistry';
import { registerAppFlowCards } from './appInit';
import {
  requireDailyBudgetService,
  requireDeviceManager,
  requirePlanService,
  requirePriceCoordinator,
} from './appInit/contextGuards';
import { buildPeriodicStatusLogFields } from '../lib/diagnostics/periodicStatus';
import type { BackgroundTasksController } from './backgroundTasksController';
import type { AppNativeWiring } from './appNativeWiring';
import type { AppPowerTracker } from './appPowerTracker';
import type { AppServiceWiring } from './appServiceWiring';
import type { PowerCalibrationStore } from '../lib/device/devicePowerCalibrationStore';
import type { PowerSamplePipeline } from './powerSamplePipeline';
import { withAppHostApi } from './appHostApi';


/** Lifecycle and runtime adapter façade above the stable host/UI surface. */
// The callback body is one class declaration; class/file line caps still apply.
// eslint-disable-next-line max-lines-per-function
export const withAppRuntimeApi = (Base: ReturnType<typeof withAppHostApi>) => {
abstract class AppRuntimeApi extends Base {
  protected abstract readonly timers: TimerRegistry;
  protected abstract readonly backgroundTasks: BackgroundTasksController;
  protected abstract readonly powerSamplePipeline: PowerSamplePipeline;
  public abstract getPowerCalibrationStore(): PowerCalibrationStore;
  protected abstract readonly serviceWiring: AppServiceWiring;
  protected abstract readonly nativeWiring: AppNativeWiring;
  protected abstract readonly powerTrackerHelpers: AppPowerTracker;
  protected abstract overheadToken?: Homey.FlowToken;
  protected abstract readonly capacitySettingsReloader: CapacitySettingsReloader;

  public reloadWeatherCollector(): void {
    this.backgroundTasks.startWeatherCollector(this.runtime.backgroundCollectors?.weatherCollector);
  }
  public recordPowerSample(powerW: number, nowMs?: number): ReturnType<AppContext['recordPowerSample']> {
    return this.powerSamplePipeline.recordPowerSample(powerW, nowMs);
  }
  public loadDailyBudgetSettings(): void {
    requireDailyBudgetService(this.context).loadSettings();
  }
  public updateDailyBudgetState(options?: DailyBudgetUpdateStateOptions): void {
    this.updateDailyBudgetAndRecordCap(options);
  }
  public syncLivePlanStateAfterTargetActuation(source: PendingTargetObservationSource): boolean | void {
    return requirePlanService(this.context).syncLivePlanStateInline(source);
  }
  public evaluateHeadroomForDevice(
    params: Parameters<PlanService['evaluateHeadroomForDevice']>[0],
  ) {
    return requirePlanService(this.context).evaluateHeadroomForDevice(params);
  }
  public getPowerCalibrationSnapshot(): PowerCalibrationSnapshot {
    return this.getPowerCalibrationStore().getSnapshot();
  }
  public async onInit(): Promise<void> { await this.serviceWiring.runInit(); }
  protected delayMs(ms: number): Promise<void> { return this.nativeWiring.delayMs(ms); }
  protected applyNativeWiringAutoDecisions(): Promise<void> {
    return this.nativeWiring.applyNativeWiringAutoDecisions();
  }
  public refreshFlowConflictsForUi(): Promise<FlowConflictRefreshResult> {
    return this.nativeWiring.refreshFlowConflictsForUi();
  }
  public async onUninit(): Promise<void> { await this.serviceWiring.runUninit(); }
  public getStructuredLogger(component: string): PinoLogger | undefined {
    return this.runtime.structuredLogger?.child({ component });
  }
  public getApiStructuredLogger(): PinoLogger | undefined { return this.getStructuredLogger('api'); }
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
  public get priceOptimizationSettings() {
    return temperaturePolicyPriceSettings(
      requirePriceCoordinator(this.context).getPriceOptimizationSettings(),
      this.context.observedTemperatureModeUpdates.allowsAutomaticAdjustments
        .bind(this.context.observedTemperatureModeUpdates),
    );
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
   * The app's userdata database, opened at its first boot step. The
   * repositories on it are each built by their own domain's wiring; only the
   * file is opened here. The test harness overrides this to open one database
   * per spec file.
   */
  protected openUserdataDatabase(): UserdataDatabase {
    return openAppUserdataDatabase();
  }
  public emitPowerTrackerPersisted(homeId: string): void {
    emitPowerTrackerPersistedForApp(this.homey, homeId, (message, error) => this.error(message, error));
  }
  public emitSettingsUiDevicesUpdated(): void {
    emitSettingsUiDevicesUpdatedForApp(this.homey, (message, error) => this.error(message, error));
  }
  public loadCapacitySettings = (): void => { this.capacitySettingsReloader.reload(); };
  public noteCapacitySettingWritten = (key: string): void => { this.capacitySettingsReloader.noteWritten(key); };
  public recoverCapacitySettingsAfterSkippedWrite = (key: string): void => {
    this.capacitySettingsReloader.recoverAfterSkippedWrite(key);
  };

  /**
   * Install a capacity read (`createCapacitySettingsReloader` decides when to
   * read and whether to rebuild). An unavailable read carries the running
   * scalars forward; a retained one applies like a resolved one, the store
   * having carried the malformed field's last accepted value. The rest of the
   * persisted settings reload with it either way.
   */
  protected installCapacitySettingsRead(capacityRead: CapacityScalarSettingsRead): void {
    const { dryRun, ...capacitySettings } = resolveInstalledCapacityScalars(
      capacityRead,
      { ...this.context.capacitySettings, dryRun: this.context.capacityDryRun },
    );
    this.context.deviceControlSettings.reload();
    this.context.capacitySettings = capacitySettings;
    this.context.capacityDryRun = dryRun;
    this.reloadHomeModeCatalog();
    requirePriceCoordinator(this.context).updatePriceOptimizationEnabled();
    void this.updateOverheadToken(this.context.capacitySettings.marginKw);
  }

  /** The rebuild after a capacity read that recovered on its retry lane. */
  protected rebuildAfterCapacitySettingsRecovered(): void {
    void this.context.planService?.rebuildPlanFromCache('settings', {
      detail: 'capacity_settings_read_recovered',
    });
  }
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
  protected savePowerTracker(nextState: AppContext['powerTracker']): void {
    this.powerTrackerHelpers.savePowerTracker(nextState);
  }
  public replacePowerTrackerForUi(nextState: AppContext['powerTracker']): void {
    this.powerTrackerHelpers.replacePowerTrackerForUi(nextState);
  }
  protected updateDailyBudgetAndRecordCap(options?: DailyBudgetUpdateStateOptions): void {
    const dailyBudgetService = requireDailyBudgetService(this.context);
    this.context.powerTracker = updateDailyBudgetAndRecordCapForApp({
      powerTracker: this.context.powerTracker,
      dailyBudgetService,
      options,
    });
  }
  protected registerAppFlowCards(): void {
    registerAppFlowCards(
      this.context,
      this.resolveHomeModeName,
      this.getHomeModeNames,
      this.getHomeOperatingMode,
      this.listDeviceTargetModes,
      this.setDeviceModeTarget,
    );
  }
  public isTemperatureControlDisabled = (deviceId: string): boolean => (
    this.context.deviceControlSettings.isTemperatureControlDisabled(
      deviceId, this.context.deviceReads.descriptor(deviceId),
    )
  );
  protected logPeriodicStatus(options: { includeDeviceHealth?: boolean } = {}): void {
    if (!this.context.capacityGuard) throw new Error('CapacityGuard must be initialized');
    if (!this.context.planEngine) throw new Error('PlanEngine must be initialized');
    this.getStructuredLogger('status')?.info(buildPeriodicStatusLogFields({
      capacityGuard: this.context.capacityGuard,
      powerTracker: this.context.powerTracker,
      capacitySettings: this.context.capacitySettings,
      operatingMode: this.getHomeOperatingMode(),
      capacityDryRun: this.context.capacityDryRun,
      starvedDeviceCount: this.context.deviceDiagnosticsService?.getCurrentStarvedDeviceCount?.() ?? 0,
      capacityPaceKw: this.context.planEngine.computeCapacityPace(),
      sheddingActive: this.context.planEngine.state.sheddingActive,
    }));
    if (options.includeDeviceHealth === true) {
      const deviceStatus = requireDeviceManager(this.context).getPeriodicStatusMetrics();
      if (deviceStatus) {
        this.getStructuredLogger('devices')?.info({ event: 'periodic_device_health_summary', ...deviceStatus });
      }
    }
    const dailyBudgetStatus = requireDailyBudgetService(this.context).getPeriodicStatusFields();
    if (dailyBudgetStatus) this.getStructuredLogger('daily_budget')?.info(dailyBudgetStatus);
  }
}

return AppRuntimeApi;
};

/** Compose both setup façades while keeping the Homey SDK value in `app.ts`. */
export const withAppApi = (Base: Parameters<typeof withAppHostApi>[0]) => (
  withAppRuntimeApi(withAppHostApi(Base))
);
