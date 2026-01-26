import Homey from 'homey';
import CapacityGuard from './lib/core/capacityGuard';
import { DeviceManager } from './lib/core/deviceManager';
import { PlanEngine } from './lib/plan/planEngine';
import { DevicePlan, ShedAction, ShedBehavior } from './lib/plan/planTypes';
import { PlanService } from './lib/plan/planService';
import { HomeyDeviceLike, TargetDeviceSnapshot } from './lib/utils/types';
import { PriceCoordinator } from './lib/price/priceCoordinator';
import { aggregateAndPruneHistory, PowerTrackerState } from './lib/core/powerTracker';
import { PriceLevel } from './lib/price/priceLevels';
import { logPeriodicStatus as logPeriodicStatusHelper } from './lib/app/appStatusLog';
import { getDeviceLoadSetting } from './lib/core/deviceLoad';
import { DailyBudgetService } from './lib/dailyBudget/dailyBudgetService';
import type { DailyBudgetUiPayload } from './lib/dailyBudget/dailyBudgetTypes';
import { type DebugLoggingTopic } from './lib/utils/debugLogging';
import { getAllModes as getAllModesHelper, getShedBehavior as getShedBehaviorHelper, resolveModeName as resolveModeNameHelper } from './lib/utils/capacityHelpers';
import { CONTROLLABLE_DEVICES, MANAGED_DEVICES, OPERATING_MODE_SETTING, PRICE_OPTIMIZATION_SETTINGS } from './lib/utils/settingsKeys';
import { isBooleanMap, isPowerTrackerState } from './lib/utils/appTypeGuards';
import { createPlanEngine, createPlanService, registerAppFlowCards, type FlowCardInitApp, type PlanEngineInitApp, type PlanServiceInitApp } from './lib/app/appInit';
import { buildDebugLoggingTopics } from './lib/app/appLoggingHelpers';
import { initSettingsHandlerForApp, loadCapacitySettingsFromHomey } from './lib/app/appSettingsHelpers';
import { disableUnsupportedDevices as disableUnsupportedDevicesHelper } from './lib/app/appDeviceSupport';
import { startAppServices } from './lib/app/appLifecycleHelpers';
import { PowerSampleRebuildState, applyPowerDeltaToTracker, buildPowerSignalFromDeviceChange } from './lib/app/appPowerHelpers';
import { recordDailyBudgetCap, recordPowerSampleForApp, schedulePlanRebuildFromSignal } from './lib/app/appPowerHelpers';
import { getHomeyDevicesForDebug, logHomeyDeviceForDebug } from './lib/app/appDeviceDebug';
import { addPerfDuration, incPerfCounter } from './lib/utils/perfCounters';
import { startPerfLogger } from './lib/app/perfLogging';
import { logDynamicElectricityPricesFromHomey } from './lib/app/appEnergyDebug';
import { resolveHomeyEnergyApiFromHomeyApi, resolveHomeyEnergyApiFromSdk, type HomeyEnergyApi } from './lib/utils/homeyEnergy';
const SNAPSHOT_REFRESH_INTERVAL_MS = 5 * 60 * 1000;
const POWER_SAMPLE_REBUILD_MIN_INTERVAL_MS = process.env.NODE_ENV === 'test' ? 0 : 2000;
const POWER_SAMPLE_REBUILD_STABLE_MIN_INTERVAL_MS = process.env.NODE_ENV === 'test' ? 0 : 5000;
const POWER_SAMPLE_REBUILD_MAX_INTERVAL_MS = 30 * 1000;
class PelsApp extends Homey.App {
  private powerTracker: PowerTrackerState = {};
  private capacityGuard?: CapacityGuard;
  private capacitySettings = { limitKw: 10, marginKw: 0.2 };
  private capacityDryRun = true;
  private operatingMode = 'Home';
  private modeAliases: Record<string, string> = {};
  private capacityPriorities: Record<string, Record<string, number>> = {};
  private modeDeviceTargets: Record<string, Record<string, number>> = {};
  private controllableDevices: Record<string, boolean> = {};
  private managedDevices: Record<string, boolean> = {};
  private shedBehaviors: Record<string, ShedBehavior> = {};
  private debugLoggingTopics = new Set<DebugLoggingTopic>();
  private dailyBudgetService!: DailyBudgetService;
  private priceCoordinator!: PriceCoordinator;
  private deviceManager!: DeviceManager;
  private planEngine!: PlanEngine;
  private planService!: PlanService;
  private defaultComputeDynamicSoftLimit?: () => number;
  private snapshotRefreshInterval?: ReturnType<typeof setInterval>;
  private isSnapshotRefreshing = false;
  private lastKnownPowerKw: Record<string, number> = {};
  private expectedPowerKwOverrides: Record<string, { kw: number; ts: number }> = {};
  private overheadToken?: Homey.FlowToken;
  private lastMeasuredPowerKw: Record<string, { kw: number; ts: number }> = {};
  private settingsHandler?: (key: string) => Promise<void>;
  private lastNotifiedOperatingMode = 'Home';
  private lastNotifiedPriceLevel: PriceLevel = PriceLevel.UNKNOWN;
  private powerSampleRebuildState: PowerSampleRebuildState = { lastMs: 0 };
  private heartbeatInterval?: ReturnType<typeof setInterval>;
  private stopPerfLogging?: () => void;
  private updateLocalSnapshot(deviceId: string, updates: { target?: number | null; on?: boolean }): void { this.deviceManager.updateLocalSnapshot(deviceId, updates); }
  private setExpectedOverride(deviceId: string, kw: number): void { this.expectedPowerKwOverrides[deviceId] = { kw, ts: Date.now() }; }
  private getHomeyEnergyApi(): HomeyEnergyApi | null {
    const sdkEnergy = resolveHomeyEnergyApiFromSdk(this.homey);
    return sdkEnergy ?? resolveHomeyEnergyApiFromHomeyApi(this.deviceManager?.getHomeyApi?.());
  }
  async getHomeyDevicesForDebug(): Promise<HomeyDeviceLike[]> { return getHomeyDevicesForDebug({ deviceManager: this.deviceManager, error: this.error.bind(this) }); }
  async logHomeyDeviceForDebug(deviceId: string): Promise<boolean> {
    return logHomeyDeviceForDebug({ deviceId, getDevicesForDebug: () => this.getHomeyDevicesForDebug(), log: this.log.bind(this) });
  }
  async onInit() {
    this.log('PELS has been initialized');
    this.updateDebugLoggingEnabled();
    this.initPriceCoordinator();
    this.migrateManagedDevices();
    this.loadCapacitySettings();
    this.initDailyBudgetService();
    await this.initDeviceManager();
    this.initCapacityGuard(); this.initPlanEngine();
    this.initPlanService(); this.initCapacityGuardProviders();
    this.initSettingsHandler();
    await startAppServices({
      loadPowerTracker: () => this.loadPowerTracker(),
      loadPriceOptimizationSettings: () => this.loadPriceOptimizationSettings(),
      initOptimizer: () => this.priceCoordinator.initOptimizer(),
      startHeartbeat: () => this.startHeartbeat(),
      updateOverheadToken: () => this.updateOverheadToken(),
      refreshTargetDevicesSnapshot: () => this.refreshTargetDevicesSnapshot(),
      rebuildPlanFromCache: () => this.planService.rebuildPlanFromCache(),
      setLastNotifiedOperatingMode: (mode) => {
        this.lastNotifiedOperatingMode = mode;
      },
      getOperatingMode: () => this.operatingMode,
      registerFlowCards: () => this.registerFlowCards(),
      startPeriodicSnapshotRefresh: () => this.startPeriodicSnapshotRefresh(),
      refreshSpotPrices: () => this.priceCoordinator.refreshSpotPrices(),
      refreshGridTariffData: () => this.priceCoordinator.refreshGridTariffData(),
      startPriceRefresh: () => this.priceCoordinator.startPriceRefresh(),
      startPriceOptimization: () => this.priceCoordinator.startPriceOptimization(),
    });
    this.startPerfLogging();
    void logDynamicElectricityPricesFromHomey({
      homey: this.homey,
      deviceManager: this.deviceManager,
      log: (...args: unknown[]) => this.log(...args),
      error: (...args: unknown[]) => this.error(...args),
    });
  }
  private initPriceCoordinator(): void {
    this.priceCoordinator = new PriceCoordinator({
      homey: this.homey,
      getHomeyEnergyApi: () => this.getHomeyEnergyApi(),
      getCurrentPriceLevel: () => this.getCurrentPriceLevel(),
      rebuildPlanFromCache: () => this.planService?.rebuildPlanFromCache() ?? Promise.resolve(),
      log: (...args: unknown[]) => this.log(...args),
      logDebug: (...args: unknown[]) => this.logDebug('price', ...args),
      error: (...args: unknown[]) => this.error(...args),
    });
  }
  private initDailyBudgetService(): void {
    this.dailyBudgetService = new DailyBudgetService({
      homey: this.homey,
      log: (...args: unknown[]) => this.log(...args),
      logDebug: (...args: unknown[]) => this.logDebug('daily_budget', ...args),
      getPowerTracker: () => this.powerTracker,
      getPriceOptimizationEnabled: () => this.priceOptimizationEnabled,
      getCapacitySettings: () => this.capacitySettings,
    });
    this.dailyBudgetService.loadSettings();
    this.dailyBudgetService.loadState();
  }
  private async initDeviceManager(): Promise<void> {
    this.deviceManager = new DeviceManager(this, {
      log: this.log.bind(this),
      debug: (...args: unknown[]) => this.logDebug('devices', ...args),
      error: this.error.bind(this),
    }, {
      getPriority: (id) => this.getPriorityForDevice(id),
      getControllable: (id) => this.isCapacityControlEnabled(id),
      getManaged: (id) => this.resolveManagedState(id),
    }, {
      expectedPowerKwOverrides: this.expectedPowerKwOverrides,
      lastKnownPowerKw: this.lastKnownPowerKw,
      lastMeasuredPowerKw: this.lastMeasuredPowerKw,
    });
    await this.deviceManager.init();
    this.deviceManager.on('powerChanged', (event: { deviceId: string; kw: number; delta?: number; deltaKw?: number }) => {
      const deltaKw = typeof event.deltaKw === 'number' ? event.deltaKw : event.delta;
      this.powerTracker = applyPowerDeltaToTracker({
        powerTracker: this.powerTracker,
        capacityGuard: this.capacityGuard,
        deltaKw,
      });
      const signal = buildPowerSignalFromDeviceChange({
        powerTracker: this.powerTracker,
        capacityGuard: this.capacityGuard,
        deltaKw,
      });
      void schedulePlanRebuildFromSignal({
        getState: () => this.powerSampleRebuildState,
        setState: (state) => {
          this.powerSampleRebuildState = state;
        },
        minIntervalMs: POWER_SAMPLE_REBUILD_MIN_INTERVAL_MS,
        stableMinIntervalMs: POWER_SAMPLE_REBUILD_STABLE_MIN_INTERVAL_MS,
        maxIntervalMs: POWER_SAMPLE_REBUILD_MAX_INTERVAL_MS,
        rebuildPlanFromCache: () => this.planService?.rebuildPlanFromCache() ?? Promise.resolve(),
        logError: (error) => {
          // Log error but don't throw - state is already persisted
          this.error('PowerTracker: Failed to rebuild plan after power signal:', error);
        },
        currentPowerW: signal.currentPowerW,
        powerDeltaW: signal.powerDeltaW,
        capacitySettings: this.capacitySettings,
        capacityGuard: this.capacityGuard,
      });
    });
  }
  private initCapacityGuard(): void {
    this.capacityGuard = new CapacityGuard({
      limitKw: this.capacitySettings.limitKw,
      softMarginKw: this.capacitySettings.marginKw,
      onShortfall: async (deficitKw) => {
        await this.handleShortfall(deficitKw);
      },
      onShortfallCleared: async () => {
        await this.handleShortfallCleared();
      },
      log: (...args) => this.log(...args),
    });
  }
  private initPlanEngine(): void {
    const deps: PlanEngineInitApp = {
      homey: this.homey,
      deviceManager: this.deviceManager,
      getCapacityGuard: () => this.capacityGuard,
      getCapacitySettings: () => this.capacitySettings,
      getCapacityDryRun: () => this.capacityDryRun,
      getOperatingMode: () => this.operatingMode,
      getModeDeviceTargets: () => this.modeDeviceTargets,
      getPowerTracker: () => this.powerTracker,
      getDailyBudgetSnapshot: () => this.dailyBudgetService.getSnapshot(),
      getPriceOptimizationEnabled: () => this.priceOptimizationEnabled,
      getPriceOptimizationSettings: () => this.priceOptimizationSettings,
      isCurrentHourCheap: () => this.isCurrentHourCheap(),
      isCurrentHourExpensive: () => this.isCurrentHourExpensive(),
      getPriorityForDevice: (deviceId) => this.getPriorityForDevice(deviceId),
      getShedBehavior: (deviceId) => this.getShedBehavior(deviceId),
      getDynamicSoftLimitOverride: () => this.getDynamicSoftLimitOverride(),
      applySheddingToDevice: (deviceId, deviceName, reason) => this.applySheddingToDevice(deviceId, deviceName, reason),
      updateLocalSnapshot: (deviceId, updates) => this.updateLocalSnapshot(deviceId, updates),
      log: (...args: unknown[]) => this.log(...args),
      logDebug: (topic: DebugLoggingTopic, ...args: unknown[]) => this.logDebug(topic, ...args),
      error: (...args: unknown[]) => this.error(...args),
    };
    this.planEngine = createPlanEngine(deps);
  }
  private initPlanService(): void {
    const deps: PlanServiceInitApp = {
      homey: this.homey,
      planEngine: this.planEngine,
      getCapacityDryRun: () => this.capacityDryRun,
      getLastPowerUpdate: () => this.powerTracker.lastTimestamp ?? null,
      getLatestTargetSnapshot: () => this.latestTargetSnapshot,
      resolveManagedState: (deviceId) => this.resolveManagedState(deviceId),
      isCapacityControlEnabled: (deviceId) => this.isCapacityControlEnabled(deviceId),
      isCurrentHourCheap: () => this.isCurrentHourCheap(),
      isCurrentHourExpensive: () => this.isCurrentHourExpensive(),
      log: (...args: unknown[]) => this.log(...args),
      logDebug: (topic: DebugLoggingTopic, ...args: unknown[]) => this.logDebug(topic, ...args),
      error: (...args: unknown[]) => this.error(...args),
    };
    this.planService = createPlanService(deps);
  }
  private initCapacityGuardProviders(): void {
    if (!this.capacityGuard) return;
    this.defaultComputeDynamicSoftLimit = this.computeDynamicSoftLimit;
    this.capacityGuard.setSoftLimitProvider(() => this.computeDynamicSoftLimit());
    this.capacityGuard.setShortfallThresholdProvider(() => this.computeShortfallThreshold());
  }
  private initSettingsHandler(): void {
    this.settingsHandler = initSettingsHandlerForApp({
      homey: this.homey,
      getOperatingMode: () => this.operatingMode,
      notifyOperatingModeChanged: (mode) => this.notifyOperatingModeChanged(mode),
      loadCapacitySettings: () => this.loadCapacitySettings(),
      rebuildPlanFromCache: () => this.planService.rebuildPlanFromCache(),
      refreshTargetDevicesSnapshot: () => this.refreshTargetDevicesSnapshot(),
      loadPowerTracker: () => this.loadPowerTracker(),
      getCapacityGuard: () => this.capacityGuard,
      getCapacitySettings: () => this.capacitySettings,
      getCapacityDryRun: () => this.capacityDryRun,
      loadPriceOptimizationSettings: () => this.loadPriceOptimizationSettings(),
      loadDailyBudgetSettings: () => this.dailyBudgetService.loadSettings(),
      updateDailyBudgetState: (options) => this.updateDailyBudgetAndRecordCap(options),
      resetDailyBudgetLearning: () => this.dailyBudgetService.resetLearning(),
      priceService: this.priceCoordinator,
      updatePriceOptimizationEnabled: (logChange) => this.updatePriceOptimizationEnabled(logChange),
      updateOverheadToken: (value) => this.updateOverheadToken(value),
      updateDebugLoggingEnabled: (logChange) => this.updateDebugLoggingEnabled(logChange),
      log: (message: string) => this.log(message),
      error: (message: string, error: Error) => this.error(message, error),
    });
  }
  async onUninit(): Promise<void> {
    if (this.snapshotRefreshInterval) {
      clearInterval(this.snapshotRefreshInterval);
      this.snapshotRefreshInterval = undefined;
    }
    if (this.powerSampleRebuildState.timer) {
      clearTimeout(this.powerSampleRebuildState.timer);
      this.powerSampleRebuildState.timer = undefined;
    }
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = undefined;
    }
    if (this.stopPerfLogging) {
      this.stopPerfLogging();
      this.stopPerfLogging = undefined;
    }
    this.priceCoordinator.stop();
    if (this.deviceManager) {
      this.deviceManager.destroy(); // stop listeners
    }
  }
  private logDebug(topic: DebugLoggingTopic, ...args: unknown[]): void {
    if (this.debugLoggingTopics.has(topic)) {
      this.log(...args);
    }
  }
  private startHeartbeat(): void {
    const updateHeartbeat = () => this.homey.settings.set('app_heartbeat', Date.now());
    updateHeartbeat();
    this.heartbeatInterval = setInterval(updateHeartbeat, 30 * 1000);
  }
  private startPerfLogging(): void {
    this.stopPerfLogging = startPerfLogger({
      isEnabled: () => this.debugLoggingTopics.has('perf'),
      log: (...args: unknown[]) => this.logDebug('perf', ...args),
      intervalMs: 30 * 1000,
    });
  }
  private getDynamicSoftLimitOverride(): number | null {
    if (!this.defaultComputeDynamicSoftLimit || this.computeDynamicSoftLimit === this.defaultComputeDynamicSoftLimit) return null;
    const value = this.computeDynamicSoftLimit();
    return Number.isFinite(value) ? value : null;
  }
  private updatePriceOptimizationEnabled(logChange = false): void {
    this.priceCoordinator.updatePriceOptimizationEnabled(logChange);
  }
  private get priceOptimizationEnabled(): boolean {
    return this.priceCoordinator.getPriceOptimizationEnabled();
  }
  private get priceOptimizationSettings(): Record<string, { enabled: boolean; cheapDelta: number; expensiveDelta: number }> {
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
    const trimmed = (mode || '').trim();
    if (!trimmed || this.lastNotifiedOperatingMode === trimmed) return;
    const card = this.homey.flow?.getTriggerCard?.('operating_mode_changed');
    if (card && typeof card.trigger === 'function') {
      card.trigger({}, { mode: trimmed }).catch((err: Error) => this.error('Failed to trigger operating_mode_changed', err));
    }
    this.lastNotifiedOperatingMode = trimmed;
  }
  private loadPowerTracker(): void {
    const stored = this.homey.settings.get('power_tracker_state') as unknown;
    if (isPowerTrackerState(stored)) {
      this.powerTracker = stored;
    }
    this.dailyBudgetService.updateState();
  }
  private migrateManagedDevices(): void {
    const managedRaw = this.homey.settings.get(MANAGED_DEVICES) as unknown;
    const controllableRaw = this.homey.settings.get(CONTROLLABLE_DEVICES) as unknown;
    const priceRaw = this.homey.settings.get(PRICE_OPTIMIZATION_SETTINGS) as unknown;
    const managed = isBooleanMap(managedRaw) ? { ...managedRaw } : {};
    const controllable = isBooleanMap(controllableRaw) ? { ...controllableRaw } : {};
    const priceEnabled = new Set<string>();
    if (priceRaw && typeof priceRaw === 'object') {
      Object.entries(priceRaw as Record<string, unknown>).forEach(([deviceId, entry]) => {
        if (entry && typeof entry === 'object' && (entry as { enabled?: unknown }).enabled === true) {
          priceEnabled.add(deviceId);
        }
      });
    }
    let managedChanged = false;
    let controllableChanged = false;
    priceEnabled.forEach((deviceId) => {
      if (!Object.prototype.hasOwnProperty.call(managed, deviceId)) {
        managed[deviceId] = true;
        managedChanged = true;
      }
    });
    Object.entries(controllable).forEach(([deviceId, isControllable]) => {
      if (isControllable === true && !Object.prototype.hasOwnProperty.call(managed, deviceId)) {
        managed[deviceId] = true;
        managedChanged = true;
      }
    });
    Object.entries(managed).forEach(([deviceId, isManaged]) => {
      if (isManaged !== true) return;
      const hasCapacity = typeof controllable[deviceId] === 'boolean';
      const hasPrice = priceEnabled.has(deviceId);
      if (!hasCapacity && !hasPrice) {
        controllable[deviceId] = true;
        controllableChanged = true;
      }
    });
    if (managedChanged) {
      this.homey.settings.set(MANAGED_DEVICES, managed);
    }
    if (controllableChanged) {
      this.homey.settings.set(CONTROLLABLE_DEVICES, controllable);
    }
    if (managedChanged || controllableChanged) {
      this.log('Migrated managed device settings to explicit managed devices.');
    }
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
    this.shedBehaviors = next.shedBehaviors;
    this.updatePriceOptimizationEnabled();
    void this.updateOverheadToken(this.capacitySettings.marginKw);
  }
  private loadPriceOptimizationSettings(): void {
    this.priceCoordinator.loadPriceOptimizationSettings();
  }
  public getDailyBudgetUiPayload(): DailyBudgetUiPayload | null {
    return this.dailyBudgetService.getUiPayload();
  }
  private async updateOverheadToken(value?: number): Promise<void> {
    const overhead = Number.isFinite(value) ? Number(value) : this.capacitySettings.marginKw;
    try {
      if (!this.overheadToken) {
        this.overheadToken = await this.homey.flow.createToken('capacity_overhead', {
          type: 'number',
          title: 'Capacity overhead (kW)',
          value: overhead ?? 0,
        });
      }
      await this.overheadToken.setValue(overhead ?? 0);
    } catch (error) {
      this.error('Failed to create/update capacity_overhead token', error as Error);
    }
  }
  private savePowerTracker(nextState: PowerTrackerState = this.powerTracker): void {
    const pruneStart = Date.now();
    const pruned = aggregateAndPruneHistory(nextState);
    addPerfDuration('power_tracker_prune_ms', Date.now() - pruneStart);
    incPerfCounter('power_tracker_save_total');
    this.powerTracker = pruned;
    const nowMs = typeof pruned.lastTimestamp === 'number' ? pruned.lastTimestamp : Date.now();
    this.updateDailyBudgetAndRecordCap({ nowMs });
    this.homey.settings.set('power_tracker_state', this.powerTracker);
    incPerfCounter('settings_set.power_tracker_state');
  }
  private updateDailyBudgetAndRecordCap(options?: { nowMs?: number; forcePlanRebuild?: boolean }): void {
    const updateStart = Date.now();
    this.dailyBudgetService.updateState(options);
    addPerfDuration('daily_budget_update_ms', Date.now() - updateStart);
    incPerfCounter('daily_budget_update_total');
    this.powerTracker = recordDailyBudgetCap({
      powerTracker: this.powerTracker,
      snapshot: this.dailyBudgetService.getSnapshot(),
    });
  }
  private async recordPowerSample(currentPowerW: number, nowMs: number = Date.now()): Promise<void> {
    const sampleStart = Date.now();
    try {
      await recordPowerSampleForApp({
        currentPowerW,
        nowMs,
        capacitySettings: this.capacitySettings,
        getLatestTargetSnapshot: () => this.latestTargetSnapshot,
        powerTracker: this.powerTracker,
        capacityGuard: this.capacityGuard,
        homey: this.homey,
        schedulePlanRebuild: () => schedulePlanRebuildFromSignal({
          getState: () => this.powerSampleRebuildState,
          setState: (state) => {
            this.powerSampleRebuildState = state;
          },
          minIntervalMs: POWER_SAMPLE_REBUILD_MIN_INTERVAL_MS,
          stableMinIntervalMs: POWER_SAMPLE_REBUILD_STABLE_MIN_INTERVAL_MS,
          maxIntervalMs: POWER_SAMPLE_REBUILD_MAX_INTERVAL_MS,
          rebuildPlanFromCache: () => this.planService?.rebuildPlanFromCache() ?? Promise.resolve(),
          logError: (error) => {
            // Log error but don't throw - state is already persisted
            this.error('PowerTracker: Failed to rebuild plan after power signal:', error);
          },
          currentPowerW,
          capacitySettings: this.capacitySettings,
          capacityGuard: this.capacityGuard,
        }),
        saveState: (state) => this.savePowerTracker(state),
      });
    } finally {
      addPerfDuration('power_sample_ms', Date.now() - sampleStart);
      incPerfCounter('power_sample_total');
    }
  }
  private registerFlowCards(): void {
    const deps: FlowCardInitApp = {
      homey: this.homey,
      resolveModeName: (mode) => this.resolveModeName(mode),
      getAllModes: () => this.getAllModes(),
      getOperatingMode: () => this.operatingMode,
      handleOperatingModeChange: (rawMode) => this.handleOperatingModeChange(rawMode),
      getCurrentPriceLevel: () => this.getCurrentPriceLevel(),
      recordPowerSample: (powerW) => this.recordPowerSample(powerW),
      capacityGuard: this.capacityGuard,
      getFlowSnapshot: () => this.getFlowSnapshot(),
      refreshTargetDevicesSnapshot: () => this.refreshTargetDevicesSnapshot(),
      getDeviceLoadSetting: (deviceId) => this.getDeviceLoadSetting(deviceId),
      setExpectedOverride: (deviceId, kw) => this.setExpectedOverride(deviceId, kw),
      storeFlowPriceData: (kind, raw) => this.storeFlowPriceData(kind, raw),
      planService: this.planService,
      loadDailyBudgetSettings: () => this.dailyBudgetService.loadSettings(),
      updateDailyBudgetState: (options) => this.dailyBudgetService.updateState(options),
      log: (...args: unknown[]) => this.log(...args),
      logDebug: (topic: DebugLoggingTopic, ...args: unknown[]) => this.logDebug(topic, ...args),
    };
    registerAppFlowCards(deps);
  }
  private async handleOperatingModeChange(rawMode: string): Promise<void> {
    const resolved = resolveModeNameHelper(rawMode, this.modeAliases);
    const previousMode = this.operatingMode;
    if (resolved !== rawMode) this.logDebug('settings', `Mode '${rawMode}' resolved via alias to '${resolved}'`);
    this.operatingMode = resolved;
    this.homey.settings.set(OPERATING_MODE_SETTING, resolved);
    this.homey.settings.set('mode_alias_used', rawMode !== resolved ? rawMode : null);
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
    const fallback = this.planService?.getLastNotifiedPriceLevel() ?? PriceLevel.UNKNOWN;
    return (status?.priceLevel || fallback) as PriceLevel;
  }
  private startPeriodicSnapshotRefresh(): void {
    if (this.snapshotRefreshInterval) clearInterval(this.snapshotRefreshInterval);
    this.snapshotRefreshInterval = setInterval(() => {
      this.refreshTargetDevicesSnapshot().catch((e) => this.error('Periodic snapshot refresh failed', e));
      logPeriodicStatusHelper({
        capacityGuard: this.capacityGuard,
        powerTracker: this.powerTracker,
        capacitySettings: this.capacitySettings,
        operatingMode: this.operatingMode,
        capacityDryRun: this.capacityDryRun,
        dailyBudgetService: this.dailyBudgetService,
        log: (...args: unknown[]) => this.log(...args),
      });
    }, SNAPSHOT_REFRESH_INTERVAL_MS);
  }
  private get latestTargetSnapshot(): TargetDeviceSnapshot[] {
    return this.deviceManager?.getSnapshot() ?? [];
  }
  setSnapshotForTests(snapshot: TargetDeviceSnapshot[]): void {
    this.deviceManager.setSnapshotForTests(snapshot);
  }
  parseDevicesForTests(list: HomeyDeviceLike[]): TargetDeviceSnapshot[] {
    return this.deviceManager.parseDeviceListForTests(list);
  }
  private async refreshTargetDevicesSnapshot(): Promise<void> {
    if (this.isSnapshotRefreshing) { this.logDebug('devices', 'Snapshot refresh already in progress, skipping'); return; }
    this.isSnapshotRefreshing = true;
    this.logDebug('devices', 'Refreshing target devices snapshot');
    try {
      await this.deviceManager.refreshSnapshot();
      const snapshot = this.deviceManager.getSnapshot(); this.homey.settings.set('target_devices_snapshot', snapshot);
      disableUnsupportedDevicesHelper({ snapshot, settings: this.homey.settings, logDebug: (...args: unknown[]) => this.logDebug('devices', ...args) });
    } finally {
      this.isSnapshotRefreshing = false;
    }
  }
  private getCombinedHourlyPrices(): unknown {
    return this.priceCoordinator.getCombinedHourlyPrices();
  }
  private findCheapestHours(count: number): string[] {
    return this.priceCoordinator.findCheapestHours(count);
  }
  private isCurrentHourCheap(): boolean {
    return this.priceCoordinator.isCurrentHourCheap();
  }
  private isCurrentHourExpensive(): boolean {
    return this.priceCoordinator.isCurrentHourExpensive();
  }
  private getCurrentHourPriceInfo(): string {
    return this.priceCoordinator.getCurrentHourPriceInfo();
  }
  storeFlowPriceData(kind: 'today' | 'tomorrow', raw: unknown): {
    dateKey: string;
    storedCount: number;
    missingHours: number[];
  } {
    return this.priceCoordinator.storeFlowPriceData(kind, raw);
  }
  private async applyPriceOptimization() {
    return this.priceCoordinator.applyPriceOptimization();
  }
  private async getDeviceLoadSetting(deviceId: string): Promise<number | null> {
    return getDeviceLoadSetting({
      deviceId,
      snapshot: this.latestTargetSnapshot,
      getHomeyApi: () => this.deviceManager.getHomeyApi(),
      initHomeyApi: () => this.deviceManager.init(),
      error: (...args: unknown[]) => this.error(...args),
    });
  }
  private getPriorityForDevice(deviceId: string): number {
    return this.capacityPriorities[this.operatingMode || 'Home']?.[deviceId] ?? 100;
  }
  private resolveModeName(name: string): string {
    return resolveModeNameHelper(name, this.modeAliases);
  }
  private getAllModes(): Set<string> {
    return getAllModesHelper(this.operatingMode, this.capacityPriorities, this.modeDeviceTargets);
  }
  private resolveManagedState(deviceId: string): boolean {
    return this.managedDevices[deviceId] === true;
  }
  private isCapacityControlEnabled(deviceId: string): boolean {
    return this.managedDevices[deviceId] === true && this.controllableDevices[deviceId] === true;
  }
  private getShedBehavior(deviceId: string): { action: ShedAction; temperature: number | null } {
    return getShedBehaviorHelper(deviceId, this.shedBehaviors);
  }
  private computeDynamicSoftLimit(): number {
    return this.planService.computeDynamicSoftLimit();
  }
  private computeShortfallThreshold(): number {
    return this.planService.computeShortfallThreshold();
  }
  private async handleShortfall(deficitKw: number): Promise<void> {
    return this.planService.handleShortfall(deficitKw);
  }
  private async handleShortfallCleared(): Promise<void> {
    return this.planService.handleShortfallCleared();
  }
  private async applyPlanActions(plan: DevicePlan): Promise<void> {
    return this.planService.applyPlanActions(plan);
  }
  private async applySheddingToDevice(deviceId: string, deviceName?: string, reason?: string): Promise<void> {
    return this.planService.applySheddingToDevice(deviceId, deviceName, reason);
  }
}
export = PelsApp;
