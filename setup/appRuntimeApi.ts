import { temperaturePolicyPriceSettings } from '../packages/shared-domain/src/settings/temperatureControl';
import { emitPowerTrackerPersistedForApp, emitSettingsUiDevicesUpdatedForApp } from './settingsUiAppRuntime';
import { openAppUserdataDatabase, type UserdataDatabase } from '../lib/store/userdataDatabase';
import type { AppContext } from '../lib/app/appContext';
import type { FlowConflictRefreshResult } from '../lib/flowApi/flowConflictRefreshCoordinator';
import type Homey from 'homey';
import type { PowerCalibrationSnapshot } from '../packages/contracts/src/powerCalibration';
import type {
  ObservedDeviceState,
  ProjectedObservedDeviceState,
  ThermalDirection,
} from '../packages/contracts/src/types';
import {
  readObservedEvChargingState,
  readObservedStateOfCharge,
  readObservedTemperatureState,
} from '../lib/observer/observedDeviceStateProjection';
import type {
  ObservedEvChargingStateRead,
  ObservedStateOfChargeRead,
  ObservedTemperatureRead,
} from '../lib/observer/observedDeviceStateProjection';
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
import type { ObservedDeviceStateProjection } from '../lib/observer/observedDeviceStateProjection';
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
  protected abstract readonly observedDeviceStateProjection: ObservedDeviceStateProjection;
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
   * question of it. They are worth naming:
   *
   * - the joins that compose it with device configuration or inventory metadata
   *   (planner input, device surfaces, the Flow-card device list);
   * - the settings-UI payload refresh, which overlays a fixed list of
   *   raw-observed fields onto the served device (`LIVE_OBSERVED_FIELDS`);
   * - the executor's drift check, which reads the reported step, measured power
   *   and EV state together to decide whether the device has moved off plan
   *   (`ObserverDeviceRead`, `lib/executor/executorDeviceRead.ts`), joined with
   *   the configuration's charger identity;
   * - external-off hold detection, which reads the binary observation and the
   *   plug state beside the configuration's charger identity.
   *
   * Separate from `getObservedState` and named for what it is, so holding the
   * record stays a deliberate choice. Before this split the drift path took the
   * base-typed read and structurally widened it, which compiled and worked only
   * because the object underneath was physically wider than its type — so a
   * `getObservedState` that ever returned a genuinely narrowed copy would have
   * changed drift decisions with no type error anywhere.
   *
   * A new holder is the general exit re-opening. Anything wanting one cluster
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

  public getObservedEvChargingState(deviceId: string): ObservedEvChargingStateRead {
    return readObservedEvChargingState(this.observedDeviceStateProjection.getObservedState(deviceId));
  }

  /** Which way this device's setpoint moves demand — the observer projection's answer. */
  public getThermalDirection(deviceId: string): ThermalDirection {
    return this.observedDeviceStateProjection.getThermalDirection(deviceId);
  }

  /** Whether this device's power reading is a live measurement — the observer projection's answer. */
  public isLiveMeasuredDraw(deviceId: string): boolean {
    return this.observedDeviceStateProjection.isLiveMeasuredDraw(deviceId);
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
  public updatePriceOptimizationEnabled = (logChange = false): void => {
    requirePriceCoordinator(this.context).updatePriceOptimizationEnabled(logChange);
  };
  public get priceOptimizationEnabled(): boolean {
    return requirePriceCoordinator(this.context).getPriceOptimizationEnabled();
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
    this.updatePriceOptimizationEnabled();
    void this.updateOverheadToken(this.context.capacitySettings.marginKw);
  }

  /** The rebuild after a capacity read that recovered on its retry lane. */
  protected rebuildAfterCapacitySettingsRecovered(): void {
    void this.context.planService?.rebuildPlanFromCache('settings', {
      detail: 'capacity_settings_read_recovered',
    });
  }
  public loadPriceOptimizationSettings = (): void => {
    requirePriceCoordinator(this.context).loadPriceOptimizationSettings();
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
