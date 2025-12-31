/* eslint-disable max-lines -- app entrypoint is large; refactor in a focused follow-up. */
import Homey from 'homey';
import CapacityGuard from './lib/core/capacityGuard';
import { DeviceManager } from './lib/core/deviceManager';
import { PlanEngine } from './lib/plan/planEngine';
import { DevicePlan, ShedAction, ShedBehavior } from './lib/plan/planTypes';
import { sumControlledUsageKw } from './lib/plan/planUsage';
import { PlanService } from './lib/plan/planService';
import { FlowHomeyLike, HomeyDeviceLike, TargetDeviceSnapshot } from './lib/utils/types';
import { PriceCoordinator } from './lib/price/priceCoordinator';
import { PriceOptimizationSettings } from './lib/price/priceOptimizer';
import { aggregateAndPruneHistory, PowerTrackerState, recordPowerSample } from './lib/core/powerTracker';
import { createSettingsHandler } from './lib/utils/settingsHandlers';
import { PriceLevel } from './lib/price/priceLevels';
import { registerFlowCards } from './flowCards/registerFlowCards';
import { buildPeriodicStatusLog } from './lib/core/periodicStatus';
import { getDeviceLoadSetting } from './lib/core/deviceLoad';
import { DailyBudgetService } from './lib/dailyBudget/dailyBudgetService';
import type { DailyBudgetUiPayload } from './lib/dailyBudget/dailyBudgetTypes';
import { ALL_DEBUG_LOGGING_TOPICS, type DebugLoggingTopic, normalizeDebugLoggingTopics } from './lib/utils/debugLogging';
import { getAllModes as getAllModesHelper, getShedBehavior as getShedBehaviorHelper, normalizeShedBehaviors as normalizeShedBehaviorsHelper,
  resolveModeName as resolveModeNameHelper } from './lib/utils/capacityHelpers';
import { CAPACITY_DRY_RUN, CAPACITY_LIMIT_KW, CAPACITY_MARGIN_KW, DEBUG_LOGGING_TOPICS, MANAGED_DEVICES, OPERATING_MODE_SETTING } from './lib/utils/settingsKeys';
import { isBooleanMap, isFiniteNumber, isModeDeviceTargets, isPowerTrackerState, isPrioritySettings, isStringMap } from './lib/utils/appTypeGuards';
const SNAPSHOT_REFRESH_INTERVAL_MS = 5 * 60 * 1000;
const POWER_SAMPLE_REBUILD_MIN_INTERVAL_MS = process.env.NODE_ENV === 'test' ? 0 : 2000;
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
  private managedDefaultsDirty = false;
  private shedBehaviors: Record<string, ShedBehavior> = {};
  private debugLoggingTopics = new Set<DebugLoggingTopic>();
  private dailyBudgetService!: DailyBudgetService;
  private priceCoordinator!: PriceCoordinator;
  private priceOptimizationSettingsLoaded = false;
  private deviceManager!: DeviceManager;
  private planEngine!: PlanEngine;
  private planService!: PlanService;
  private defaultComputeDynamicSoftLimit?: () => number;
  private snapshotRefreshInterval?: ReturnType<typeof setInterval>;
  private lastKnownPowerKw: Record<string, number> = {};
  private expectedPowerKwOverrides: Record<string, { kw: number; ts: number }> = {};
  private overheadToken?: Homey.FlowToken;
  private lastMeasuredPowerKw: Record<string, { kw: number; ts: number }> = {};
  private settingsHandler?: (key: string) => Promise<void>;
  private lastNotifiedOperatingMode = 'Home';
  private lastNotifiedPriceLevel: PriceLevel = PriceLevel.UNKNOWN;
  private lastPowerSamplePlanRebuildMs = 0;
  private pendingPowerSampleRebuild?: Promise<void>;
  private powerSampleRebuildTimer?: ReturnType<typeof setTimeout>;
  private heartbeatInterval?: ReturnType<typeof setInterval>;
  private updateLocalSnapshot(deviceId: string, updates: { target?: number | null; on?: boolean }): void {
    this.deviceManager.updateLocalSnapshot(deviceId, updates);
  }
  async onInit() {
    this.log('PELS has been initialized');
    this.updateDebugLoggingTopics();
    this.initPriceCoordinator();
    this.loadCapacitySettings();
    this.initDailyBudgetService();
    await this.initDeviceManager();
    this.initCapacityGuard();
    this.initPlanEngine();
    this.initPlanService();
    this.initCapacityGuardProviders();
    this.initSettingsHandler();
    await this.startApp();
  }
  private updateDebugLoggingTopics(logChange = false): void {
    const rawTopics = this.homey.settings.get(DEBUG_LOGGING_TOPICS) as unknown;
    let enabledTopics = normalizeDebugLoggingTopics(rawTopics);
    if (enabledTopics.length === 0) {
      const legacyEnabled = this.homey.settings.get('debug_logging_enabled') as unknown;
      if (legacyEnabled === true) {
        enabledTopics = [...ALL_DEBUG_LOGGING_TOPICS];
      }
    }
    this.debugLoggingTopics = new Set(enabledTopics);
    if (logChange) {
      const label = enabledTopics.length ? enabledTopics.join(', ') : 'disabled';
      this.log(`Debug logging topics: ${label}`);
    }
  }
  private initPriceCoordinator(): void {
    this.priceCoordinator = new PriceCoordinator({
      homey: this.homey,
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
      getPriceOptimizationEnabled: () => this.getPriceOptimizationEnabled(),
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
    this.planEngine = new PlanEngine({
      homey: this.homey,
      deviceManager: this.deviceManager,
      getCapacityGuard: () => this.capacityGuard,
      getCapacitySettings: () => this.capacitySettings,
      getCapacityDryRun: () => this.capacityDryRun,
      getOperatingMode: () => this.operatingMode,
      getModeDeviceTargets: () => this.modeDeviceTargets,
      getPriceOptimizationEnabled: () => this.getPriceOptimizationEnabled(),
      getPriceOptimizationSettings: () => this.getPriceOptimizationSettings(),
      isCurrentHourCheap: () => this.isCurrentHourCheap(),
      isCurrentHourExpensive: () => this.isCurrentHourExpensive(),
      getPowerTracker: () => this.powerTracker,
      getDailyBudgetSnapshot: () => this.dailyBudgetService.getSnapshot(),
      getPriorityForDevice: (deviceId) => this.getPriorityForDevice(deviceId),
      getShedBehavior: (deviceId) => this.getShedBehavior(deviceId),
      getDynamicSoftLimitOverride: () => this.getDynamicSoftLimitOverride(),
      applySheddingToDevice: (deviceId, deviceName, reason) => this.applySheddingToDevice(deviceId, deviceName, reason),
      updateLocalSnapshot: (deviceId, updates) => this.updateLocalSnapshot(deviceId, updates),
      log: (...args: unknown[]) => this.log(...args),
      logDebug: (...args: unknown[]) => this.logDebug('plan', ...args),
      error: (...args: unknown[]) => this.error(...args),
    });
  }
  private initPlanService(): void {
    this.planService = new PlanService({
      homey: this.homey,
      planEngine: this.planEngine,
      getPlanDevices: () => this.latestTargetSnapshot.map((device) => ({
        ...device,
        managed: this.resolveManagedState(device.id),
        controllable: this.isCapacityControlEnabled(device.id),
      })).filter((device) => device.managed !== false),
      getCapacityDryRun: () => this.capacityDryRun,
      log: (...args: unknown[]) => this.log(...args),
      logDebug: (...args: unknown[]) => this.logDebug('plan', ...args),
      error: (...args: unknown[]) => this.error(...args),
      isCurrentHourCheap: () => this.isCurrentHourCheap(),
      isCurrentHourExpensive: () => this.isCurrentHourExpensive(),
      getCombinedPrices: () => this.homey.settings.get('combined_prices') as unknown,
      getLastPowerUpdate: () => this.powerTracker.lastTimestamp ?? null,
    });
  }
  private initCapacityGuardProviders(): void {
    if (!this.capacityGuard) return;
    this.defaultComputeDynamicSoftLimit = this.computeDynamicSoftLimit;
    this.capacityGuard.setSoftLimitProvider(() => this.computeDynamicSoftLimit());
    this.capacityGuard.setShortfallThresholdProvider(() => this.computeShortfallThreshold());
  }
  private initSettingsHandler(): void {
    this.settingsHandler = createSettingsHandler({
      homey: this.homey,
      loadCapacitySettings: () => this.loadCapacitySettings(),
      rebuildPlanFromCache: () => this.planService.rebuildPlanFromCache(),
      refreshTargetDevicesSnapshot: () => this.refreshTargetDevicesSnapshot(),
      loadPowerTracker: () => this.loadPowerTracker(),
      getCapacityGuard: () => this.capacityGuard,
      getCapacitySettings: () => this.capacitySettings,
      getCapacityDryRun: () => this.capacityDryRun,
      loadPriceOptimizationSettings: () => this.loadPriceOptimizationSettings(),
      loadDailyBudgetSettings: () => this.dailyBudgetService.loadSettings(),
      updateDailyBudgetState: (options) => this.dailyBudgetService.updateState(options),
      resetDailyBudgetLearning: () => this.dailyBudgetService.resetLearning(),
      priceService: this.priceCoordinator,
      updatePriceOptimizationEnabled: (logChange) => this.updatePriceOptimizationEnabled(logChange),
      updateOverheadToken: (value) => this.updateOverheadToken(value),
      updateDebugLoggingEnabled: (logChange) => this.updateDebugLoggingEnabled(logChange),
      log: (message: string) => this.log(message),
      errorLog: (message: string, error: unknown) => this.error(message, error as Error),
    });
    this.homey.settings.on('set', async (key: string) => {
      await this.settingsHandler?.(key);
      if (key === OPERATING_MODE_SETTING) {
        this.notifyOperatingModeChanged(this.operatingMode);
      }
    });
  }
  private async startApp(): Promise<void> {
    this.loadPowerTracker();
    this.loadPriceOptimizationSettings();
    this.priceCoordinator.initOptimizer();
    this.startHeartbeat();
    void this.updateOverheadToken();
    await this.refreshTargetDevicesSnapshot();
    await this.planService.rebuildPlanFromCache();
    this.lastNotifiedOperatingMode = this.operatingMode;
    this.registerFlowCards();
    this.startPeriodicSnapshotRefresh();
    await this.priceCoordinator.refreshSpotPrices();
    await this.priceCoordinator.refreshNettleieData();
    this.priceCoordinator.startPriceRefresh();
    await this.priceCoordinator.startPriceOptimization();
  }
  async onUninit(): Promise<void> {
    if (this.snapshotRefreshInterval) {
      clearInterval(this.snapshotRefreshInterval);
      this.snapshotRefreshInterval = undefined;
    }
    if (this.powerSampleRebuildTimer) {
      clearTimeout(this.powerSampleRebuildTimer);
      this.powerSampleRebuildTimer = undefined;
    }
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = undefined;
    }
    this.priceCoordinator.stop();
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
    this.updateDebugLoggingTopics(logChange);
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
  private loadCapacitySettings(): void {
    const limit = this.homey.settings.get(CAPACITY_LIMIT_KW) as unknown;
    const margin = this.homey.settings.get(CAPACITY_MARGIN_KW) as unknown;
    const modeRaw = this.homey.settings.get(OPERATING_MODE_SETTING) as unknown;
    const modeAliases = this.homey.settings.get('mode_aliases') as unknown;
    const priorities = this.homey.settings.get('capacity_priorities') as unknown;
    const modeTargets = this.homey.settings.get('mode_device_targets') as unknown;
    const dryRun = this.homey.settings.get(CAPACITY_DRY_RUN) as unknown;
    const controllables = this.homey.settings.get('controllable_devices') as unknown;
    const managed = this.homey.settings.get(MANAGED_DEVICES) as unknown;
    const rawShedBehaviors = this.homey.settings.get('overshoot_behaviors') as unknown;
    if (isFiniteNumber(limit)) this.capacitySettings.limitKw = limit;
    if (isFiniteNumber(margin)) this.capacitySettings.marginKw = margin;
    if (isStringMap(modeAliases)) {
      this.modeAliases = Object.fromEntries(
        Object.entries(modeAliases).map(([k, v]) => [k.toLowerCase(), v]),
      );
    }
    if (typeof modeRaw === 'string' && modeRaw.length > 0) {
      const resolvedMode = resolveModeNameHelper(modeRaw, this.modeAliases);
      this.operatingMode = resolvedMode;
    }
    if (isPrioritySettings(priorities)) this.capacityPriorities = priorities;
    if (isModeDeviceTargets(modeTargets)) this.modeDeviceTargets = modeTargets;
    if (typeof dryRun === 'boolean') this.capacityDryRun = dryRun;
    if (isBooleanMap(controllables)) this.controllableDevices = controllables;
    if (isBooleanMap(managed)) this.managedDevices = managed;
    this.managedDefaultsDirty = false;
    this.shedBehaviors = normalizeShedBehaviorsHelper(rawShedBehaviors as Record<string, ShedBehavior> | undefined);
    this.updatePriceOptimizationEnabled();
    void this.updateOverheadToken(this.capacitySettings.marginKw);
  }
  private loadPriceOptimizationSettings(): void {
    this.priceCoordinator.loadPriceOptimizationSettings();
    this.priceOptimizationSettingsLoaded = true;
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
    const pruned = aggregateAndPruneHistory(nextState);
    this.powerTracker = pruned;
    const nowMs = typeof pruned.lastTimestamp === 'number' ? pruned.lastTimestamp : Date.now();
    this.dailyBudgetService.updateState({ nowMs });
    this.recordDailyBudgetCap(this.dailyBudgetService.getSnapshot());
    this.homey.settings.set('power_tracker_state', this.powerTracker);
  }
  private recordDailyBudgetCap(snapshot: DailyBudgetUiPayload | null): void {
    if (!snapshot?.budget.enabled) return;
    const planned = snapshot.buckets.plannedKWh;
    const startUtc = snapshot.buckets.startUtc;
    const index = snapshot.currentBucketIndex;
    if (!Array.isArray(planned) || !Array.isArray(startUtc)) return;
    if (index < 0 || index >= planned.length || index >= startUtc.length) return;
    const plannedKWh = planned[index];
    const bucketKey = startUtc[index];
    if (!Number.isFinite(plannedKWh) || typeof bucketKey !== 'string') return;
    const nextCaps = new Map<string, number>(Object.entries(this.powerTracker.dailyBudgetCaps || {}));
    nextCaps.set(bucketKey, plannedKWh);
    this.powerTracker.dailyBudgetCaps = Object.fromEntries(nextCaps);
  }
  private async recordPowerSample(currentPowerW: number, nowMs: number = Date.now()): Promise<void> {
    const hourBudgetKWh = Math.max(0, this.capacitySettings.limitKw - this.capacitySettings.marginKw);
    const snapshot = this.latestTargetSnapshot;
    const totalKw = snapshot.length ? sumControlledUsageKw(snapshot) : null;
    const controlledPowerW = totalKw !== null ? Math.max(0, totalKw * 1000) : undefined;
    await recordPowerSample({
      state: this.powerTracker,
      currentPowerW,
      controlledPowerW,
      nowMs,
      capacityGuard: this.capacityGuard,
      hourBudgetKWh,
      rebuildPlanFromCache: () => this.schedulePlanRebuildFromPowerSample(),
      saveState: (state) => this.savePowerTracker(state),
      homey: this.homey,
    });
  }
  private schedulePlanRebuildFromPowerSample(): Promise<void> {
    const now = Date.now();
    const elapsedMs = now - this.lastPowerSamplePlanRebuildMs;
    if (elapsedMs >= POWER_SAMPLE_REBUILD_MIN_INTERVAL_MS) {
      this.lastPowerSamplePlanRebuildMs = now;
      return this.planService.rebuildPlanFromCache();
    }
    if (!this.pendingPowerSampleRebuild) {
      const waitMs = Math.max(0, POWER_SAMPLE_REBUILD_MIN_INTERVAL_MS - elapsedMs);
      this.pendingPowerSampleRebuild = new Promise((resolve) => {
        this.powerSampleRebuildTimer = setTimeout(() => {
          this.powerSampleRebuildTimer = undefined;
          this.lastPowerSamplePlanRebuildMs = Date.now();
          this.planService.rebuildPlanFromCache()
            .catch((error) => {
              // Log error but don't throw - state is already persisted
              this.error('PowerTracker: Failed to rebuild plan after power sample:', error as Error);
            })
            .finally(() => {
              this.pendingPowerSampleRebuild = undefined;
              resolve();
            });
        }, waitMs);
      });
    }
    return this.pendingPowerSampleRebuild;
  }
  private registerFlowCards(): void {
    registerFlowCards({
      homey: this.homey as FlowHomeyLike,
      resolveModeName: (mode) => this.resolveModeName(mode),
      getAllModes: () => this.getAllModes(),
      getCurrentOperatingMode: () => this.operatingMode,
      handleOperatingModeChange: (rawMode) => this.handleOperatingModeChange(rawMode),
      getCurrentPriceLevel: () => this.getCurrentPriceLevel(),
      recordPowerSample: (powerW) => this.recordPowerSample(powerW),
      getCapacityGuard: () => this.capacityGuard,
      getHeadroom: () => this.capacityGuard?.getHeadroom() ?? null,
      setCapacityLimit: (kw) => this.capacityGuard?.setLimit(kw),
      getSnapshot: () => this.getFlowSnapshot(),
      refreshSnapshot: () => this.refreshTargetDevicesSnapshot(),
      getDeviceLoadSetting: (deviceId) => this.getDeviceLoadSetting(deviceId),
      setExpectedOverride: (deviceId, kw) => {
        this.expectedPowerKwOverrides[deviceId] = { kw, ts: Date.now() };
      },
      rebuildPlan: () => this.planService.rebuildPlanFromCache(),
      log: (...args: unknown[]) => this.log(...args),
      logDebug: (...args: unknown[]) => this.logDebug('settings', ...args),
    });
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
      this.logPeriodicStatus();
    }, SNAPSHOT_REFRESH_INTERVAL_MS);
  }
  private logPeriodicStatus(): void {
    this.log(buildPeriodicStatusLog({
      capacityGuard: this.capacityGuard, powerTracker: this.powerTracker, capacitySettings: this.capacitySettings,
      operatingMode: this.operatingMode, capacityDryRun: this.capacityDryRun,
    }));
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
    this.logDebug('devices', 'Refreshing target devices snapshot');
    await this.deviceManager.refreshSnapshot();
    this.syncManagedDefaults();
    this.homey.settings.set('target_devices_snapshot', this.deviceManager.getSnapshot());
  }
  private getCombinedHourlyPrices(): unknown {
    return this.priceCoordinator.getCombinedHourlyPrices();
  }
  private getPriceOptimizationEnabled(): boolean {
    return this.priceCoordinator.getPriceOptimizationEnabled();
  }
  private getPriceOptimizationSettings(): Record<string, PriceOptimizationSettings> {
    return this.priceCoordinator.getPriceOptimizationSettings();
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
    const existing = this.managedDevices[deviceId];
    if (typeof existing === 'boolean') return existing;
    if (!this.priceOptimizationSettingsLoaded) {
      this.loadPriceOptimizationSettings();
    }
    const capacityEnabled = this.controllableDevices[deviceId] !== false;
    const priceEnabled = this.getPriceOptimizationSettings()[deviceId]?.enabled === true;
    const managed = capacityEnabled || priceEnabled;
    this.managedDevices[deviceId] = managed;
    this.managedDefaultsDirty = true;
    return managed;
  }
  private isCapacityControlEnabled(deviceId: string): boolean {
    return this.resolveManagedState(deviceId) && this.controllableDevices[deviceId] !== false;
  }
  private syncManagedDefaults(): void {
    if (!this.managedDefaultsDirty) return;
    this.managedDefaultsDirty = false;
    this.homey.settings.set(MANAGED_DEVICES, this.managedDevices);
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
