import Homey from 'homey';
import CapacityGuard from './capacityGuard';
import { DeviceManager } from './deviceManager';
import { TargetDeviceSnapshot } from './types';
import PriceService from './priceService';
import { PriceOptimizer } from './priceOptimizer';
import { aggregateAndPruneHistory, PowerTrackerState, recordPowerSample } from './powerTracker';
import { createSettingsHandler } from './settingsHandlers';
import { PriceLevel } from './priceLevels';
import { registerFlowCards } from './flowCards/registerFlowCards';

const OPERATING_MODE_SETTING = 'operating_mode';
const PRICE_LOGIC_SOURCE_SETTING = 'price_logic_source';
const EXTERNAL_PRICE_LEVEL_SETTING = 'external_price_level';

// Timing constants for shedding/restore behavior
const SHED_COOLDOWN_MS = 60000; // Wait 60s after shedding before considering restores
const RESTORE_COOLDOWN_MS = 30000; // Wait 30s after restore for power to stabilize
const RECENT_SHED_RESTORE_BACKOFF_MS = 3 * 60 * 1000; // Wait up to 3 minutes after a shed before retrying restore
const RECENT_SHED_RESTORE_MULTIPLIER = 1.07; // Require ~7% more headroom if device was just shed
const RECENT_SHED_EXTRA_BUFFER_KW = 0.08; // Or at least an extra 0.08 kW cushion when re-restoring
const RECENT_RESTORE_SHED_GRACE_MS = 3 * 60 * 1000; // Avoid re-shedding a freshly restored device for 3 minutes unless overshoot is large
const RECENT_RESTORE_OVERSHOOT_BYPASS_KW = 0.5; // Allow immediate re-shed if overshoot is >= 0.5 kW
const SWAP_TIMEOUT_MS = 60000; // Clear pending swaps after 60s if they couldn't complete
const SNAPSHOT_REFRESH_INTERVAL_MS = 5 * 60 * 1000; // Refresh device snapshot every 5 minutes

type ShedAction = 'turn_off' | 'set_temperature';

type ShedBehavior = {
  action: ShedAction;
  temperature?: number;
};

type DevicePlanDevice = {
  id: string;
  name: string;
  currentState: string;
  plannedState: string;
  currentTarget: unknown;
  plannedTarget: number | null;
  priority?: number;
  powerKw?: number;
  expectedPowerKw?: number;
  measuredPowerKw?: number;
  reason?: string;
  zone?: string;
  controllable?: boolean;
  currentTemperature?: number;
  shedAction?: ShedAction;
  shedTemperature?: number | null;
};

type DevicePlan = {
  meta: {
    totalKw: number | null;
    softLimitKw: number;
    headroomKw: number | null;
    hourlyBudgetExhausted?: boolean;
    usedKWh?: number;
    budgetKWh?: number;
    minutesRemaining?: number;
  };
  devices: DevicePlanDevice[];
};

module.exports = class PelsApp extends Homey.App {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Homey API has no TypeScript definitions
  private powerTracker: PowerTrackerState = {};

  private capacityGuard?: CapacityGuard;
  private capacitySettings = {
    limitKw: 10,
    marginKw: 0.2,
  };

  private capacityDryRun = true;
  private priceOptimizationEnabled = true;
  private operatingMode = 'Home';
  private modeAliases: Record<string, string> = {};
  private capacityPriorities: Record<string, Record<string, number>> = {};
  private modeDeviceTargets: Record<string, Record<string, number>> = {};
  private controllableDevices: Record<string, boolean> = {};
  private shedBehaviors: Record<string, ShedBehavior> = {};
  private lastDeviceShedMs: Record<string, number> = {};
  private lastDeviceRestoreMs: Record<string, number> = {};
  private pendingSheds = new Set<string>(); // Devices currently being shed (in-flight)
  private pendingRestores = new Set<string>(); // Devices currently being restored (in-flight)
  private lastSheddingMs: number | null = null;
  private lastOvershootMs: number | null = null;
  private lastRestoreMs: number | null = null; // Track when we last restored a device
  private lastPlannedShedIds: Set<string> = new Set();
  private lastShedPlanMeasurementTs: number | null = null;
  private lastSwapPlanMeasurementTs: Record<string, number> = {};
  private inShortfall = false; // Track if we're currently in a capacity shortfall state
  private debugLoggingEnabled = false;
  // Track devices that were swapped out: swappedOutDeviceId -> higherPriorityDeviceId
  // These devices should not be restored until the higher-priority device they were swapped for is restored
  private swappedOutFor: Record<string, string> = {};
  // Track devices that are swap targets (higher-priority devices waiting to restore via swap)
  // No device with lower priority than a pending swap target should restore first
  private pendingSwapTargets: Set<string> = new Set();
  private pendingSwapTimestamps: Record<string, number> = {};
  // Homey API client (available when Homey token/local URL are accessible)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- HomeyAPI lacks types
  private homeyApi?: any;
  private priceService!: PriceService;
  private deviceManager!: DeviceManager;
  private priceOptimizer?: PriceOptimizer;

  private lastPlanSignature = '';
  private snapshotRefreshInterval?: ReturnType<typeof setInterval>;
  private priceRefreshInterval?: ReturnType<typeof setInterval>;
  // Set when remaining hourly energy budget has been fully consumed (remainingKWh <= 0)
  private hourlyBudgetExhausted = false;
  // Track last known power draw (kW) for each device when it was ON and drawing power > 0
  // Used as a fallback estimate when settings.load is not available
  private lastKnownPowerKw: Record<string, number> = {};
  // Temporary overrides set via flow card until real power is reported again
  private expectedPowerKwOverrides: Record<string, { kw: number; ts: number }> = {};
  // Flow token exposing capacity overhead (margin) in kW
  // Flow token exposing capacity overhead (margin) in kW
  private overheadToken?: Homey.FlowToken;
  // Flow token exposing the current price level
  private priceLevelToken?: Homey.FlowToken;
  // Track last measured power reading with timestamp to compare recency
  private lastMeasuredPowerKw: Record<string, { kw: number; ts: number }> = {};
  // Price optimization settings per device: { deviceId: { enabled, cheapDelta, expensiveDelta } }
  private priceOptimizationSettings: Record<string, {
    enabled: boolean;
    cheapDelta: number;
    expensiveDelta: number;
  }> = {};
  private settingsHandler?: (key: string) => void;
  private lastNotifiedOperatingMode = 'Home';
  private lastNotifiedPriceLevel: PriceLevel = PriceLevel.UNKNOWN;
  private lastPriceLogicSource = 'internal';

  // Delegated to DeviceManager
  private updateLocalSnapshot(deviceId: string, updates: { target?: number | null; on?: boolean }): void {
    this.deviceManager.updateLocalSnapshot(deviceId, updates);
  }

  /**
   * onInit is called when the app is initialized.
   */
  async onInit() {
    this.log('PELS has been initialized');

    // Debug logging is opt-in per session; always start disabled.
    this.debugLoggingEnabled = false;
    this.homey.settings.set('debug_logging_enabled', false);
    this.loadCapacitySettings();
    this.deviceManager = new DeviceManager(this, {
      log: this.log.bind(this),
      debug: this.logDebug.bind(this),
      error: this.error.bind(this),
    }, {
      getPriority: (id) => this.getPriorityForDevice(id),
      getControllable: (id) => this.controllableDevices[id] ?? true,
    }, {
      expectedPowerKwOverrides: this.expectedPowerKwOverrides,
      lastKnownPowerKw: this.lastKnownPowerKw,
      lastMeasuredPowerKw: this.lastMeasuredPowerKw,
    });
    this.priceService = new PriceService(
      this.homey,
      this.log.bind(this),
      this.logDebug.bind(this),
      this.error.bind(this),
    );
    // TODO: make price handling pluggable (strategy per region) rather than hardcoded NO spot/nettleie blend.
    await this.deviceManager.init();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- HomeyAPI lacks types
    this.homeyApi = (this.deviceManager as any).homeyApi;
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
    this.capacityGuard.setSoftLimitProvider(() => this.computeDynamicSoftLimit());
    this.capacityGuard.setShortfallThresholdProvider(() => this.computeShortfallThreshold());

    this.settingsHandler = createSettingsHandler({
      homey: this.homey,
      loadCapacitySettings: () => this.loadCapacitySettings(),
      rebuildPlanFromCache: () => this.rebuildPlanFromCache(),
      refreshTargetDevicesSnapshot: () => this.refreshTargetDevicesSnapshot(),
      loadPowerTracker: () => this.loadPowerTracker(),
      getCapacityGuard: () => this.capacityGuard,
      getCapacitySettings: () => this.capacitySettings,
      getCapacityDryRun: () => this.capacityDryRun,
      loadPriceOptimizationSettings: () => this.loadPriceOptimizationSettings(),
      priceService: this.priceService,
      updatePriceOptimizationEnabled: (logChange) => this.updatePriceOptimizationEnabled(logChange),
      updatePriceLogicSource: (logChange) => this.updatePriceLogicSource(logChange),
      updateOverheadToken: (value) => void this.updateOverheadToken(value),
      updateDebugLoggingEnabled: (logChange) => this.updateDebugLoggingEnabled(logChange),
      errorLog: (message: string, error: unknown) => this.error(message, error as Error),
    });
    this.homey.settings.on('set', (key: string) => {
      this.settingsHandler?.(key);
      if (key === OPERATING_MODE_SETTING) {
        this.notifyOperatingModeChanged(this.operatingMode);
      }
    });

    this.loadPowerTracker();
    this.loadPriceOptimizationSettings();
    this.priceOptimizer = this.buildPriceOptimizer();
    void this.updateOverheadToken();
    await this.refreshTargetDevicesSnapshot();
    this.rebuildPlanFromCache(); // Build initial plan after snapshot is loaded
    this.lastNotifiedOperatingMode = this.operatingMode;
    this.registerFlowCards();
    this.startPeriodicSnapshotRefresh();
    this.lastPriceLogicSource = this.getPriceLogicSource();
    if (!this.isExternalPriceLogic()) {
      // Refresh prices (will use cache if we have today's data, and update combined_prices)
      await this.priceService.refreshSpotPrices();
      await this.priceService.refreshNettleieData();
      this.startPriceRefresh();
    }
    await this.startPriceOptimization();
  }

  /**
   * onUninit is called when the app is destroyed.
   * Clean up intervals and timers.
   */
  async onUninit(): Promise<void> {
    if (this.snapshotRefreshInterval) {
      clearInterval(this.snapshotRefreshInterval);
      this.snapshotRefreshInterval = undefined;
    }
    this.stopPriceRefresh();
    this.priceOptimizer?.stop();
    // Guard no longer needs cleanup (no interval)
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Debug logging accepts any arguments
  private logDebug(...args: any[]): void {
    if (this.debugLoggingEnabled) this.log(...args);
  }

  private getCooldownState(): { cooldownRemainingMs: number; inCooldown: boolean } {
    const sinceShedding = this.lastSheddingMs ? Date.now() - this.lastSheddingMs : null;
    const sinceOvershoot = this.lastOvershootMs ? Date.now() - this.lastOvershootMs : null;
    const cooldownSince = [sinceShedding, sinceOvershoot].filter((v) => v !== null) as number[];
    const cooldownRemainingMs = cooldownSince.length
      ? Math.max(0, SHED_COOLDOWN_MS - Math.min(...cooldownSince))
      : 0;
    const inCooldown = cooldownRemainingMs > 0;
    return { cooldownRemainingMs, inCooldown };
  }

  private updatePriceOptimizationEnabled(logChange = false): void {
    const enabled = this.homey.settings.get('price_optimization_enabled');
    this.priceOptimizationEnabled = enabled !== false; // Default to true
    if (logChange) {
      this.log(`Price optimization ${this.priceOptimizationEnabled ? 'enabled' : 'disabled'}`);
    }
  }

  private updateDebugLoggingEnabled(logChange = false): void {
    const enabled = this.homey.settings.get('debug_logging_enabled');
    this.debugLoggingEnabled = enabled === true;
    if (logChange) {
      this.log(`Debug logging ${this.debugLoggingEnabled ? 'enabled' : 'disabled'}`);
    }
  }

  private getPriceLogicSource(): string {
    const source = this.homey.settings.get(PRICE_LOGIC_SOURCE_SETTING);
    return typeof source === 'string' && source.trim() ? source.trim() : 'internal';
  }

  private isExternalPriceLogic(): boolean {
    return this.getPriceLogicSource() === 'external';
  }

  private getExternalPriceLevel(): PriceLevel {
    const raw = this.homey.settings.get(EXTERNAL_PRICE_LEVEL_SETTING);
    const normalized = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
    if (Object.values(PriceLevel).includes(normalized as PriceLevel)) {
      return normalized as PriceLevel;
    }
    return PriceLevel.UNKNOWN;
  }

  private updatePriceLogicSource(logChange = false): void {
    const source = this.getPriceLogicSource();
    if (logChange && source !== this.lastPriceLogicSource) {
      this.log(`Price logic source set to ${source === 'external' ? 'external flow' : 'internal (spot prices)'}`);
    }
    this.lastPriceLogicSource = source;
    if (source === 'external') {
      this.stopPriceRefresh();
    } else {
      this.startPriceRefresh();
      this.priceService.refreshSpotPrices().catch((error: Error) => {
        this.error('Failed to refresh spot prices', error);
      });
      this.priceService.refreshNettleieData().catch((error: Error) => {
        this.error('Failed to refresh nettleie data', error);
      });
    }
    this.rebuildPlanFromCache();
  }

  private setExternalPriceLevel(level: PriceLevel): void {
    const previous = this.getExternalPriceLevel();
    const normalized = Object.values(PriceLevel).includes(level) ? level : PriceLevel.UNKNOWN;
    this.homey.settings.set(EXTERNAL_PRICE_LEVEL_SETTING, normalized);
    this.log(`External price level set to ${normalized}`);
    if (this.isExternalPriceLogic() && normalized !== previous) {
      this.lastNotifiedPriceLevel = normalized;
      void this.updatePriceLevelToken(normalized);
      const card = this.homey.flow?.getTriggerCard?.('price_level_changed');
      if (card) {
        card
          .trigger({ level: normalized }, { priceLevel: normalized })
          .catch((err: Error) => this.error('Failed to trigger price_level_changed', err));
      }
      const genericCard = this.homey.flow?.getTriggerCard?.('price_level_changed_generic');
      if (genericCard) {
        genericCard
          .trigger({ level: normalized }, { priceLevel: normalized })
          .catch((err: Error) => this.error('Failed to trigger price_level_changed_generic', err));
      }
    }
    if (!this.isExternalPriceLogic()) {
      this.logDebug(`External price level set to ${normalized} (ignored while internal price logic is active)`);
    }
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
    const stored = this.homey.settings.get('power_tracker_state');
    if (stored && typeof stored === 'object') {
      this.powerTracker = stored;
    }
  }

  private loadCapacitySettings(): void {
    const limit = this.homey.settings.get('capacity_limit_kw');
    const margin = this.homey.settings.get('capacity_margin_kw');
    const modeRaw = this.homey.settings.get(OPERATING_MODE_SETTING);
    const modeAliases = this.homey.settings.get('mode_aliases');
    const priorities = this.homey.settings.get('capacity_priorities');
    const modeTargets = this.homey.settings.get('mode_device_targets');
    const dryRun = this.homey.settings.get('capacity_dry_run');
    const controllables = this.homey.settings.get('controllable_devices');
    const rawShedBehaviors = this.homey.settings.get('overshoot_behaviors');
    if (Number.isFinite(limit)) this.capacitySettings.limitKw = Number(limit);
    if (Number.isFinite(margin)) this.capacitySettings.marginKw = Number(margin);
    if (modeAliases && typeof modeAliases === 'object') {
      this.modeAliases = Object.entries(modeAliases).reduce<Record<string, string>>((acc, [k, v]) => {
        if (typeof k === 'string' && typeof v === 'string') acc[k.toLowerCase()] = v;
        return acc;
      }, {});
    }
    if (typeof modeRaw === 'string' && modeRaw.length > 0) {
      const resolvedMode = this.resolveModeName(modeRaw);
      this.operatingMode = resolvedMode;
    }
    if (priorities && typeof priorities === 'object') this.capacityPriorities = priorities as Record<string, Record<string, number>>;
    if (modeTargets && typeof modeTargets === 'object') this.modeDeviceTargets = modeTargets as Record<string, Record<string, number>>;
    if (typeof dryRun === 'boolean') this.capacityDryRun = dryRun;
    if (controllables && typeof controllables === 'object') this.controllableDevices = controllables as Record<string, boolean>;
    this.shedBehaviors = this.normalizeShedBehaviors(rawShedBehaviors);
    this.updatePriceOptimizationEnabled();
    void this.updateOverheadToken(this.capacitySettings.marginKw);
  }

  private loadPriceOptimizationSettings(): void {
    const settings = this.homey.settings.get('price_optimization_settings');
    if (settings && typeof settings === 'object') {
      this.priceOptimizationSettings = settings as Record<string, {
        enabled: boolean;
        cheapDelta: number;
        expensiveDelta: number;
      }>;
    }
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

  private savePowerTracker(): void {
    aggregateAndPruneHistory(this.powerTracker, this.homey);
    this.homey.settings.set('power_tracker_state', this.powerTracker);
  }

  private async ensurePriceLevelToken(level: PriceLevel): Promise<Homey.FlowToken | null> {
    if (this.priceLevelToken) return this.priceLevelToken;
    try {
      this.priceLevelToken = await this.homey.flow.createToken('pels_price_level', {
        type: 'string',
        title: 'Price level',
        value: level,
      });
      return this.priceLevelToken;
    } catch (error) {
      const err = error as { statusCode?: number };
      const flowWithTokens = this.homey.flow as Homey.App['homey']['flow'] & {
        getToken?: (id: string) => Promise<Homey.FlowToken>;
      };
      if (err?.statusCode === 409 && typeof flowWithTokens.getToken === 'function') {
        this.priceLevelToken = await flowWithTokens.getToken('pels_price_level');
        return this.priceLevelToken ?? null;
      }
      this.error('Failed to create pels_price_level token', error as Error);
    }
    return null;
  }

  private async updatePriceLevelToken(level: PriceLevel): Promise<void> {
    try {
      const token = await this.ensurePriceLevelToken(level);
      if (!token) return;
      await token.setValue(level);
    } catch (error) {
      this.error('Failed to update pels_price_level token', error as Error);
    }
  }

  private async recordPowerSample(currentPowerW: number, nowMs: number = Date.now()): Promise<void> {
    await recordPowerSample({
      state: this.powerTracker,
      currentPowerW,
      nowMs,
      capacityGuard: this.capacityGuard,
      rebuildPlanFromCache: () => this.rebuildPlanFromCache(),
      saveState: () => this.savePowerTracker(),
      homey: this.homey,
    });
  }

  // Replaced by deviceManager.init()
  // private async initHomeyApi(): Promise<void> { ... }

  private registerFlowCards(): void {
    registerFlowCards({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Homey Flow APIs lack TypeScript types
      homey: this.homey as any,
      resolveModeName: (mode) => this.resolveModeName(mode),
      getAllModes: () => this.getAllModes(),
      getCurrentOperatingMode: () => this.operatingMode,
      handleOperatingModeChange: (rawMode) => this.handleOperatingModeChange(rawMode),
      getCurrentPriceLevel: () => this.getCurrentPriceLevel(),
      setExternalPriceLevel: (level) => this.setExternalPriceLevel(level),
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
      rebuildPlan: () => this.rebuildPlanFromCache(),
      log: (...args: unknown[]) => this.log(...args),
      logDebug: (...args: unknown[]) => this.logDebug(...args),
    });
  }

  private async handleOperatingModeChange(rawMode: string): Promise<void> {
    const resolved = this.resolveModeName(rawMode);
    const previousMode = this.operatingMode;
    if (resolved !== rawMode) {
      this.logDebug(`Mode '${rawMode}' resolved via alias to '${resolved}'. Flows using the old name should be updated.`);
    }
    this.operatingMode = resolved;
    this.homey.settings.set(OPERATING_MODE_SETTING, resolved);
    this.homey.settings.set('mode_alias_used', rawMode !== resolved ? rawMode : null);
    // rebuildPlanFromCache() is triggered by the settings listener.
    if (previousMode && previousMode.toLowerCase() === resolved.toLowerCase()) {
      this.logDebug(`Mode '${resolved}' already active; plan will re-sync targets to correct drift`);
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
    if (this.isExternalPriceLogic()) {
      return this.getExternalPriceLevel();
    }
    const status = this.homey.settings.get('pels_status') as { priceLevel?: PriceLevel } | null;
    return (status?.priceLevel || this.lastNotifiedPriceLevel) as PriceLevel;
  }

  private startPeriodicSnapshotRefresh(): void {
    // Refresh device snapshot every 5 minutes to keep states current
    this.snapshotRefreshInterval = setInterval(() => {
      this.refreshTargetDevicesSnapshot().catch((error: Error) => {
        this.error('Periodic snapshot refresh failed', error);
      });
      this.logPeriodicStatus();
    }, SNAPSHOT_REFRESH_INTERVAL_MS);
  }

  private logPeriodicStatus(): void {
    const headroom = this.capacityGuard?.getHeadroom() ?? null;
    const total = this.capacityGuard?.getLastTotalPower() ?? null;
    const softLimit = this.capacityGuard?.getSoftLimit() ?? this.capacitySettings.limitKw;
    const sheddingActive = this.capacityGuard?.isSheddingActive() ?? false;
    const inShortfall = this.capacityGuard?.isInShortfall() ?? false;

    // Get current hour usage
    const now = Date.now();
    const date = new Date(now);
    date.setMinutes(0, 0, 0);
    const hourStart = date.getTime();
    const bucketKey = new Date(hourStart).toISOString();
    const usedKWh = this.powerTracker.buckets?.[bucketKey] || 0;
    const budgetKWh = this.capacitySettings.limitKw;

    const statusParts: string[] = [];
    if (total !== null) {
      statusParts.push(`power=${total.toFixed(2)}kW`);
    }
    statusParts.push(`limit=${softLimit.toFixed(2)}kW`);
    if (headroom !== null) {
      statusParts.push(`headroom=${headroom.toFixed(2)}kW`);
    }
    statusParts.push(`used=${usedKWh.toFixed(2)}/${budgetKWh.toFixed(1)}kWh`);
    if (sheddingActive) {
      statusParts.push('SHEDDING');
    }
    if (inShortfall) {
      statusParts.push('SHORTFALL');
    }
    statusParts.push(`mode=${this.operatingMode}`);
    if (this.capacityDryRun) {
      statusParts.push('dry-run');
    }

    this.log(`Status: ${statusParts.join(', ')}`);
  }

  // Proxy to DeviceManager for backward compatibility during refactor
  private get latestTargetSnapshot(): TargetDeviceSnapshot[] {
    return this.deviceManager ? this.deviceManager.getSnapshot() : [];
  }

  // Test helpers
  setSnapshotForTests(snapshot: TargetDeviceSnapshot[]): void {
    this.deviceManager.setSnapshotForTests(snapshot);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  parseDevicesForTests(list: any[]): TargetDeviceSnapshot[] {
    return this.deviceManager.parseDeviceListForTests(list);
  }

  private async refreshTargetDevicesSnapshot(): Promise<void> {
    this.logDebug('Refreshing target devices snapshot');

    await this.deviceManager.refreshSnapshot();
    const snapshot = this.deviceManager.getSnapshot();

    this.homey.settings.set('target_devices_snapshot', snapshot);
    this.logDebug(`Stored snapshot with ${snapshot.length} devices`);
    // Note: We don't call buildDevicePlanSnapshot() here - plan building happens
    // in rebuildPlanFromCache() which is called during recordPowerSample().
    // This prevents duplicate plan builds when periodic refresh coincides with power samples.
  }

  private async refreshNettleieData(forceRefresh = false): Promise<void> {
    await this.priceService.refreshNettleieData(forceRefresh);
  }

  /**
   * Update the combined_prices setting with spot + nettleie + surcharge.
   * Includes pre-calculated thresholds and cheap/expensive flags for UI consistency.
   */
  private updateCombinedPrices(): void {
    this.priceService.updateCombinedPrices();
  }

  private async refreshSpotPrices(forceRefresh = false): Promise<void> {
    await this.priceService.refreshSpotPrices(forceRefresh);
  }

  /**
   * Get combined hourly prices (spot + nettleie + provider surcharge) for all available hours.
   * Returns an array sorted by time, with total price in øre/kWh including VAT.
   */
  private getCombinedHourlyPrices() {
    return this.priceService.getCombinedHourlyPrices();
  }

  /**
   * Find the cheapest N hours from now within the next 24 hours.
   * Returns the start times of the cheapest hours.
   */
  private findCheapestHours(count: number): string[] {
    return this.priceService.findCheapestHours(count);
  }

  /**
   * Check if the current hour is cheap (25% below average).
   */
  private isCurrentHourCheap(): boolean {
    if (this.isExternalPriceLogic()) {
      return this.getExternalPriceLevel() === PriceLevel.CHEAP;
    }
    return this.priceService.isCurrentHourCheap();
  }

  /**
   * Check if the current hour is expensive (25% above average).
   */
  private isCurrentHourExpensive(): boolean {
    if (this.isExternalPriceLogic()) {
      return this.getExternalPriceLevel() === PriceLevel.EXPENSIVE;
    }
    return this.priceService.isCurrentHourExpensive();
  }

  /**
   * Get a human-readable price info for the current hour.
   */
  private getCurrentHourPriceInfo(): string {
    if (this.isExternalPriceLogic()) {
      const level = this.getExternalPriceLevel();
      return `External price level: ${level}`;
    }
    return this.priceService.getCurrentHourPriceInfo();
  }

  private buildPriceOptimizer(): PriceOptimizer {
    return new PriceOptimizer({
      priceStatus: {
        getCurrentLevel: () => this.getCurrentPriceLevel(),
        isCurrentHourCheap: () => this.isCurrentHourCheap(),
        isCurrentHourExpensive: () => this.isCurrentHourExpensive(),
        getCombinedHourlyPrices: () => this.getCombinedHourlyPrices(),
        getCurrentHourPriceInfo: () => this.getCurrentHourPriceInfo(),
      },
      getSettings: () => this.priceOptimizationSettings,
      isEnabled: () => this.priceOptimizationEnabled,
      getThresholdPercent: () => this.homey.settings.get('price_threshold_percent') ?? 25,
      getMinDiffOre: () => this.homey.settings.get('price_min_diff_ore') ?? 0,
      rebuildPlan: (reason) => {
        this.logDebug(`Price optimization: triggering plan rebuild (${reason})`);
        this.rebuildPlanFromCache();
      },
      log: (...args: unknown[]) => this.log(...args),
      logDebug: (...args: unknown[]) => this.logDebug(...args),
      error: (...args: unknown[]) => this.error(...args),
    });
  }

  /**
   * Apply price optimization to all configured devices (delegated via plan rebuild).
   */
  private async applyPriceOptimization(): Promise<void> {
    await this.priceOptimizer?.applyOnce();
  }

  private async startPriceOptimization(): Promise<void> {
    await this.priceOptimizer?.start();
  }

  /**
   * Start periodic price data refresh.
   * Refreshes spot prices and nettleie data periodically.
   * Note: Initial fetch is done in onInit before this is called.
   */
  private startPriceRefresh(): void {
    if (this.isExternalPriceLogic()) {
      this.logDebug('Price refresh skipped: external price logic selected');
      return;
    }
    if (this.priceRefreshInterval) {
      clearInterval(this.priceRefreshInterval);
      this.priceRefreshInterval = undefined;
    }
    // Refresh prices every 3 hours
    const refreshIntervalMs = 3 * 60 * 60 * 1000;

    this.priceRefreshInterval = setInterval(() => {
      this.priceService.refreshSpotPrices().catch((error: Error) => {
        this.error('Failed to refresh spot prices', error);
      });
      this.priceService.refreshNettleieData().catch((error: Error) => {
        this.error('Failed to refresh nettleie data', error);
      });
    }, refreshIntervalMs);
  }

  private stopPriceRefresh(): void {
    if (this.priceRefreshInterval) {
      clearInterval(this.priceRefreshInterval);
      this.priceRefreshInterval = undefined;
    }
  }

  private async getDeviceLoadSetting(deviceId: string): Promise<number | null> {
    const snapshotLoadKw = this.latestTargetSnapshot.find((d) => d.id === deviceId)?.loadKw;
    if (typeof snapshotLoadKw === 'number' && snapshotLoadKw > 0) {
      return snapshotLoadKw * 1000;
    }

    try {
      // Prefer HomeyAPI client; if not ready, retry init once and log.
      let homeyApi = this.deviceManager.getHomeyApi();
      if (!homeyApi?.devices?.getDevices) {
        this.error('HomeyAPI not ready for load lookup, retrying init');
        await this.deviceManager.init();
        homeyApi = this.deviceManager.getHomeyApi();
      }

      if (!homeyApi?.devices?.getDevices) {
        this.error('HomeyAPI still not ready for load lookup; skipping load lookup');
        return null;
      }

      const devices = await homeyApi.devices.getDevices();
      const list = (Array.isArray(devices) ? devices : Object.values(devices || {})) as Array<{
        id?: string;
        data?: { id?: string };
        settings?: { load?: number };
      }>;
      const device = list.find((d) => d.id === deviceId || d.data?.id === deviceId);
      if (device && typeof device.settings?.load === 'number') {
        return device.settings.load;
      }
    } catch (error) {
      const errObj = error as { status?: number; response?: { status?: number } };
      const maybeStatus = errObj?.status ?? errObj?.response?.status;
      this.error('Failed to read device via manager/devices for load:', (error as Error)?.message || error, maybeStatus ? `(status ${maybeStatus})` : '');
    }

    return null;
  }

  private rebuildPlanFromCache(): void {
    const plan = this.buildDevicePlanSnapshot(this.latestTargetSnapshot ?? []);
    // Log planned changes (dry run) for visibility, but skip if nothing changed.
    const signature = JSON.stringify(
      plan.devices.map((d) => ({
        id: d.id,
        plannedState: d.plannedState,
        plannedTarget: d.plannedTarget,
        currentState: d.currentState,
        reason: d.reason,
      })),
    );
    if (signature !== this.lastPlanSignature) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Plan meta has dynamic structure
        const headroom = (plan as any).meta?.headroomKw;
        const changes = [...plan.devices].filter((d) => {
          if (d.controllable === false) return false;
          const desiredPower = d.plannedState === 'shed' && d.shedAction !== 'set_temperature' ? 'off' : 'on';
          const samePower = desiredPower === d.currentState;
          // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Target values can be various types
          const normalizeTarget = (v: any) => (Number.isFinite(v) ? Number(v) : v ?? null);
          const sameTarget = normalizeTarget(d.plannedTarget) === normalizeTarget(d.currentTarget);
          return !(samePower && sameTarget);
        });
        const lines = changes
          .sort((a, b) => {
            const pa = a.priority ?? 999;
            const pb = b.priority ?? 999;
            if (pa !== pb) return pa - pb;
            return (a.name || '').localeCompare(b.name || '');
          })
          .map((d) => {
            const temp = `${d.currentTarget ?? '–'}° -> ${d.plannedTarget ?? '–'}°`;
            const nextPower = d.plannedState === 'shed'
              ? (d.shedAction === 'set_temperature'
                ? `set temp${typeof d.plannedTarget === 'number' ? ` ${d.plannedTarget}°` : ''}`
                : 'off')
              : 'on';
            const power = `${d.currentState} -> ${nextPower}`;
            const powerInfo = typeof d.powerKw === 'number'
              ? `, est ${d.powerKw.toFixed(2)}kW`
              : '';
            const headroomInfo = typeof headroom === 'number'
              ? `, headroom ${headroom.toFixed(2)}kW`
              : '';
            const restoringHint = d.currentState === 'off' && nextPower === 'on'
              ? ` (restoring, needs ~${(typeof d.powerKw === 'number' ? d.powerKw : 1).toFixed(2)}kW${typeof headroom === 'number' ? ` vs headroom ${headroom.toFixed(2)}kW` : ''
              })`
              : '';
            return `${d.name}: temp ${temp}, power ${power}${powerInfo}${headroomInfo}, reason: ${d.reason ?? 'n/a'
              }${restoringHint}`;
          });
        if (lines.length) {
          this.logDebug(`Plan updated (${lines.length} devices):\n- ${lines.join('\n- ')}`);
        }
      } catch (err) {
        this.logDebug('Plan updated (logging failed)', err);
      }
      this.lastPlanSignature = signature;
    }
    this.homey.settings.set('device_plan_snapshot', plan);
    // Emit realtime event so settings page can update
    this.homey.api.realtime('plan_updated', plan).catch(() => { });
    // Update PELS status for mode indicator device
    this.updatePelsStatus(plan);
    const hasShedding = plan.devices.some((d) => d.plannedState === 'shed');
    if (this.capacityDryRun && hasShedding) {
      this.log('Dry run: shedding planned but not executed');
    }
    if (!this.capacityDryRun) {
      this.applyPlanActions(plan).catch((error: Error) => this.error('Failed to apply plan actions', error));
    }
  }

  private updatePelsStatus(plan: DevicePlan): void {
    // Compute price level
    let priceLevel: PriceLevel = PriceLevel.UNKNOWN;
    if (this.isExternalPriceLogic()) {
      priceLevel = this.getExternalPriceLevel();
    } else {
      const isCheap = this.isCurrentHourCheap();
      const isExpensive = this.isCurrentHourExpensive();
      const prices = this.homey.settings.get('combined_prices') as { prices?: Array<{ total: number }> } | null;
      if (prices?.prices && prices.prices.length > 0) {
        if (isCheap) priceLevel = PriceLevel.CHEAP;
        else if (isExpensive) priceLevel = PriceLevel.EXPENSIVE;
        else priceLevel = PriceLevel.NORMAL;
      }
    }

    const hasShedding = plan.devices.some((d) => d.plannedState === 'shed');

    // Count controlled devices on/off
    const controllableDevices = plan.devices.filter((d) => d.controllable !== false);
    const devicesOn = controllableDevices.filter((d) => {
      const treatedAsOff = d.plannedState === 'shed' && d.shedAction !== 'set_temperature';
      return d.currentState === 'on' && !treatedAsOff;
    }).length;
    const devicesOff = controllableDevices.filter((d) => {
      const treatedAsOff = d.plannedState === 'shed' && d.shedAction !== 'set_temperature';
      return d.currentState === 'off' || treatedAsOff;
    }).length;

    const status = {
      headroomKw: plan.meta.headroomKw,
      hourlyUsageKwh: plan.meta.usedKWh ?? 0,
      shedding: hasShedding,
      priceLevel,
      devicesOn,
      devicesOff,
      lastPowerUpdate: this.powerTracker.lastTimestamp ?? null,
    };

    this.homey.settings.set('pels_status', status);
    void this.updatePriceLevelToken(priceLevel);

    // Trigger price level changed flow card if price level changed
    if (priceLevel !== this.lastNotifiedPriceLevel) {
      this.lastNotifiedPriceLevel = priceLevel;
      const card = this.homey.flow?.getTriggerCard?.('price_level_changed');
      if (card) {
        card
          .trigger({ level: priceLevel }, { priceLevel })
          .catch((err: Error) => this.error('Failed to trigger price_level_changed', err));
      }
      const genericCard = this.homey.flow?.getTriggerCard?.('price_level_changed_generic');
      if (genericCard) {
        genericCard
          .trigger({ level: priceLevel }, { priceLevel })
          .catch((err: Error) => this.error('Failed to trigger price_level_changed_generic', err));
      }
    }
  }

  private buildDevicePlanSnapshot(devices: Array<{
    id: string;
    name: string;
    targets: Array<{ id: string; value: unknown; unit: string }>;
    powerKw?: number;
    expectedPowerKw?: number;
    measuredPowerKw?: number;
    priority?: number;
    currentOn?: boolean;
    zone?: string;
    controllable?: boolean;
    currentTemperature?: number;
  }>): DevicePlan {
    const desiredForMode = this.modeDeviceTargets[this.operatingMode] || {};
    const total = this.capacityGuard ? this.capacityGuard.getLastTotalPower() : null;
    const softLimit = this.computeDynamicSoftLimit();

    // Compute used/budget kWh for this hour
    const budgetKWh = Math.max(0, this.capacitySettings.limitKw - this.capacitySettings.marginKw);
    const now = Date.now();
    const hourStart = new Date(now);
    hourStart.setMinutes(0, 0, 0);
    const bucketKey = hourStart.toISOString();
    const usedKWh = this.powerTracker.buckets?.[bucketKey] || 0;
    const hourEnd = hourStart.getTime() + 60 * 60 * 1000;
    const minutesRemaining = Math.max(0, (hourEnd - now) / 60000);

    const headroomRaw = total === null ? null : softLimit - total;
    // headroom is the ACTUAL available capacity. Use this for shedding.
    let headroom = headroomRaw === null && softLimit <= 0 ? -1 : headroomRaw;

    // Hysteresis for restoration is handled in the restore logic (using restoreHysteresis),
    // so we don't need to subtract margin here. Subtracting it here caused false shedding.

    // If the hourly energy budget is exhausted and soft limit is zero while instantaneous power reads ~0,
    // force a minimal negative headroom to proactively shed controllable devices.
    if (this.hourlyBudgetExhausted && softLimit <= 0 && total !== null && total <= 0.01) {
      headroom = -1; // triggers shedding logic with needed ~=1 kW (effectivePower fallback)
    }

    let sheddingActive = this.capacityGuard ? this.capacityGuard.isSheddingActive() : false;
    const shedSet = new Set<string>();
    const shedReasons = new Map<string, string>();
    const restoreMarginPlanning = Math.max(0.1, this.capacitySettings.marginKw || 0);
    if (headroom !== null && headroom < 0) {
      const measurementTs = this.powerTracker.lastTimestamp ?? null;
      const alreadyShedThisSample = measurementTs !== null && measurementTs === this.lastShedPlanMeasurementTs;
      if (alreadyShedThisSample) {
        this.logDebug('Plan: skipping additional shedding until a new power measurement arrives');
      }
      const needed = -headroom;
      if (!alreadyShedThisSample) {
        this.logDebug(
          `Planning shed: soft=${softLimit.toFixed(3)} headroom=${headroom.toFixed(
            3,
          )} total=${total === null ? 'unknown' : total.toFixed(3)}`,
        );
        const nowTs = Date.now();
        const candidates = devices
          .filter((d) => d.controllable !== false && d.currentOn !== false)
          .map((d) => {
            const priority = this.getPriorityForDevice(d.id);
            let power: number;
            if (typeof d.measuredPowerKw === 'number') {
              power = Math.max(0, d.measuredPowerKw);
            } else if (typeof d.expectedPowerKw === 'number' && d.expectedPowerKw > 0) {
              power = d.expectedPowerKw;
            } else if (typeof d.powerKw === 'number' && d.powerKw > 0) {
              power = d.powerKw;
            } else {
              power = 1;
            }
            return { ...d, priority, effectivePower: power };
          })
          .filter((d) => {
            // Check if device is effectively shed (at shed temperature)
            const shedBehavior = this.getShedBehavior(d.id);
            if (shedBehavior.action === 'set_temperature' && shedBehavior.temperature !== null) {
              const currentTarget = d.targets?.[0]?.value;
              if (typeof currentTarget === 'number' && currentTarget === shedBehavior.temperature) {
                return false;
              }
            }
            return true;
          })
          .filter((d) => {
            const lastRestore = this.lastDeviceRestoreMs[d.id];
            if (!lastRestore) return true;
            const sinceRestoreMs = nowTs - lastRestore;
            const recentlyRestored = sinceRestoreMs < RECENT_RESTORE_SHED_GRACE_MS;
            const overshootSevere = needed > RECENT_RESTORE_OVERSHOOT_BYPASS_KW;
            if (recentlyRestored && !overshootSevere) {
              this.logDebug(
                `Plan: protecting ${d.name} from shedding (recently restored ${Math.round(sinceRestoreMs / 1000)}s ago, overshoot ${needed.toFixed(2)}kW)`,
              );
              return false;
            }
            return true;
          })
          .sort((a, b) => {
            // Sort by priority descending: higher number = less important = shed first
            // Priority 1 = most important = shed last
            // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Extended device object with effectivePower
            const pa = (a as any).priority ?? 100;
            // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Extended device object with effectivePower
            const pb = (b as any).priority ?? 100;
            if (pa !== pb) return pb - pa; // Higher number sheds first
            // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Extended device object with effectivePower
            return (b as any).effectivePower - (a as any).effectivePower;
          });

        let remaining = needed;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Extended device object with effectivePower
        const totalSheddable = candidates.reduce((sum, c) => sum + ((c as any).effectivePower as number), 0);
        this.log(`Plan: overshoot=${needed.toFixed(2)}kW, candidates=${candidates.length}, totalSheddable=${totalSheddable.toFixed(2)}kW`);
        for (const c of candidates) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Extended device object with effectivePower
          if ((c as any).effectivePower <= 0) continue;

          if (remaining <= 0) break;
          shedSet.add(c.id);
          // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Extended device object with effectivePower
          shedReasons.set(c.id, 'shed due to capacity');
          // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Extended device object with effectivePower
          remaining -= (c as any).effectivePower as number;
        }

        if (shedSet.size > 0) {
          this.lastOvershootMs = Date.now();
          if (measurementTs !== null) {
            this.lastShedPlanMeasurementTs = measurementTs;
          }
        }
      }
    }

    // Update Guard state based on shedding decisions
    const hasShedding = shedSet.size > 0;
    const hasNegativeHeadroom = headroom !== null && headroom < 0;
    const remainingCandidates = headroom !== null && headroom < 0
      ? devices.filter((d) => d.controllable !== false && d.currentOn !== false && !shedSet.has(d.id)).length
      : 0;

    // Note: We call the async Guard methods but don't await - they're fire-and-forget
    // This keeps buildDevicePlanSnapshot synchronous as expected by callers
    if (hasNegativeHeadroom || hasShedding) {
      void this.capacityGuard?.setSheddingActive(true);
      const deficitKw = headroom !== null ? -headroom : 0;
      void this.capacityGuard?.checkShortfall(remainingCandidates > 0, deficitKw);
    } else {
      const restoreMargin = this.capacityGuard?.getRestoreMargin() ?? 0.2;
      if (headroom !== null && headroom >= restoreMargin) {
        void this.capacityGuard?.setSheddingActive(false);
        sheddingActive = false;
      }
      // Check shortfall clearing (will handle hysteresis internally)
      void this.capacityGuard?.checkShortfall(true, 0);
    }

    // Sync shortfall state from guard
    const guardInShortfall = this.capacityGuard?.isInShortfall() ?? false;
    if (guardInShortfall !== this.inShortfall) {
      this.inShortfall = guardInShortfall;
      this.homey.settings.set('capacity_in_shortfall', guardInShortfall);
    }

    const planDevices = devices.map((dev) => {
      const priority = this.getPriorityForDevice(dev.id);
      const desired = desiredForMode[dev.id];
      let plannedTarget = Number.isFinite(desired) ? Number(desired) : null;

      // Apply price optimization delta if configured for this device
      const priceOptConfig = this.priceOptimizationSettings[dev.id];
      if (this.priceOptimizationEnabled && plannedTarget !== null && priceOptConfig?.enabled) {
        const isCheap = this.isCurrentHourCheap();
        const isExpensive = this.isCurrentHourExpensive();
        if (isCheap && priceOptConfig.cheapDelta) {
          plannedTarget += priceOptConfig.cheapDelta;
        } else if (isExpensive && priceOptConfig.expensiveDelta) {
          plannedTarget += priceOptConfig.expensiveDelta;
        }
      }

      const currentTarget = Array.isArray(dev.targets) && dev.targets.length ? dev.targets[0].value ?? null : null;
      // eslint-disable-next-line no-nested-ternary -- Clear boolean-to-state mapping
      const currentState = typeof dev.currentOn === 'boolean' ? (dev.currentOn ? 'on' : 'off') : 'unknown';
      const controllable = dev.controllable !== false;
      const shedBehavior = this.getShedBehavior(dev.id);
      let shedAction: ShedAction = 'turn_off';
      let shedTemperature: number | null = null;
      // eslint-disable-next-line no-nested-ternary -- Clear controllable-to-state mapping
      let plannedState = controllable ? (shedSet.has(dev.id) ? 'shed' : 'keep') : 'keep';
      let reason = controllable ? shedReasons.get(dev.id) || `keep (priority ${priority})` : 'not controllable by PELS';

      if (controllable && shedSet.has(dev.id)) {
        if (shedBehavior.action === 'set_temperature' && shedBehavior.temperature !== null) {
          shedAction = 'set_temperature';
          shedTemperature = shedBehavior.temperature;
          plannedTarget = shedBehavior.temperature;
        }
      }

      if (controllable && plannedState !== 'shed' && currentState === 'off') {
        const need = (dev.powerKw && dev.powerKw > 0 ? dev.powerKw : 1) + restoreMarginPlanning;
        const hr = headroomRaw;
        // Only show "restore" reason if we're not in shortfall - otherwise device won't actually restore
        if (guardInShortfall) {
          plannedState = 'shed';
          reason = 'stay off while in capacity shortfall';
        } else {
          reason = `restore (need ${need.toFixed(2)}kW, headroom ${hr === null ? 'unknown' : hr.toFixed(2)}kW)`;
        }
      }

      // If hourly energy budget exhausted, proactively shed any controllable device that is currently on (or unknown state)
      if (this.hourlyBudgetExhausted && controllable && plannedState !== 'shed' && (currentState === 'on' || currentState === 'unknown')) {
        plannedState = 'shed';
        reason = 'shed due to exhausted hourly energy budget';
      }

      // If the device is already at its configured shed temperature, keep it marked as shed
      // so UI and logic reflect the lowered-temperature shedding state.
      const atShedTemperature = shedBehavior.action === 'set_temperature'
        && shedBehavior.temperature !== null
        && (Number(currentTarget) === shedBehavior.temperature
          || Number(plannedTarget) === shedBehavior.temperature
          || this.lastPlannedShedIds.has(dev.id));
      const shedWindowActive = this.capacityGuard?.isSheddingActive?.() === true
        || (this.lastOvershootMs !== null && Date.now() - this.lastOvershootMs < SHED_COOLDOWN_MS);
      if (controllable && atShedTemperature && shedWindowActive) {
        plannedState = 'shed';
        shedAction = 'set_temperature';
        shedTemperature = shedBehavior.temperature;
        plannedTarget = shedBehavior.temperature;
        reason = shedReasons.get(dev.id) || 'shed due to capacity';
      }

      return {
        id: dev.id,
        name: dev.name,
        currentState,
        plannedState,
        currentTarget,
        plannedTarget,
        priority,
        powerKw: dev.powerKw,
        expectedPowerKw: dev.expectedPowerKw,
        measuredPowerKw: dev.measuredPowerKw,
        reason,
        zone: dev.zone || 'Unknown',
        controllable,
        currentTemperature: dev.currentTemperature,
        shedAction,
        shedTemperature,
      };
    });

    // Secondary guard: if a device is currently off and headroom is still below what it needs plus margin,
    // keep it shed to avoid on/off flapping.
    // Also limit cumulative restore to 50% of available headroom to prevent oscillation.
    // Also respect cooldown period after shedding to avoid rapid on/off cycles.
    // Also wait after restoring a device to let the power measurement stabilize before restoring more.
    const nowTs = Date.now();
    const measurementTs = this.powerTracker.lastTimestamp ?? null;
    const sinceRestore = this.lastRestoreMs ? nowTs - this.lastRestoreMs : null;
    const sinceShedding = this.lastSheddingMs ? nowTs - this.lastSheddingMs : null;
    const sinceOvershoot = this.lastOvershootMs ? nowTs - this.lastOvershootMs : null;
    const { cooldownRemainingMs, inCooldown } = this.getCooldownState();
    const inRestoreCooldown = sinceRestore !== null && sinceRestore < RESTORE_COOLDOWN_MS;
    const activeOvershoot = headroomRaw !== null && headroomRaw < 0;

    // Clean up stale swap tracking - if a swap couldn't complete within timeout, release the blocked devices
    const swapCleanupNow = Date.now();
    for (const swapTargetId of [...this.pendingSwapTargets]) {
      const swapTime = this.pendingSwapTimestamps[swapTargetId];
      if (swapTime && swapCleanupNow - swapTime > SWAP_TIMEOUT_MS) {
        const swapName = planDevices.find((d) => d.id === swapTargetId)?.name || swapTargetId;
        this.log(`Plan: clearing stale swap for ${swapName} (${Math.round((swapCleanupNow - swapTime) / 1000)}s since swap initiated)`);
        this.pendingSwapTargets.delete(swapTargetId);
        delete this.pendingSwapTimestamps[swapTargetId];
        // Also clear any swappedOutFor entries pointing to this target
        for (const [deviceId, targetId] of Object.entries(this.swappedOutFor)) {
          if (targetId === swapTargetId) {
            delete this.swappedOutFor[deviceId];
          }
        }
      }
    }

    // Initialize restoration variables common to both loops
    let availableHeadroom = headroomRaw !== null ? headroomRaw : 0;
    const restoredThisCycle = new Set<string>();
    // Restore safety buffer: require headroom to stay positive by this much AFTER restore
    const restoreHysteresis = Math.max(0.2, restoreMarginPlanning * 2);
    let restoredOneThisCycle = false;

    if (headroomRaw !== null && !sheddingActive && !inCooldown && !inRestoreCooldown) {
      // Sort off devices by priority (priority 1 = most important, restore first)
      const offDevices = planDevices
        .filter((d) => d.controllable !== false && d.currentState === 'off' && d.plannedState !== 'shed')
        .sort((a, b) => (a.priority ?? 999) - (b.priority ?? 999)); // Lower number = higher importance

      // Get ON devices sorted by priority (higher number = less important, shed first for swaps)
      const onDevices = planDevices
        .filter((d) => d.controllable !== false && d.currentState === 'on' && d.plannedState !== 'shed')
        // Devices configured to use a minimum temperature while shedding cannot free headroom via swap
        // Treat them as non-swappable so we don't thrash trying to shed them repeatedly
        .filter((d) => this.getShedBehavior(d.id).action !== 'set_temperature')
        .sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0)); // Higher number = shed first


      for (const dev of offDevices) {
        // Skip if we already restored one device this cycle
        if (restoredOneThisCycle) {
          dev.plannedState = 'shed';
          dev.reason = 'stay shed while power stabilizes';
          continue;
        }

        const lastDeviceShed = this.lastDeviceShedMs[dev.id];
        const recentlyShed = Boolean(
          lastDeviceShed && Date.now() - lastDeviceShed < RECENT_SHED_RESTORE_BACKOFF_MS,
        );

        // Check if this device was swapped out for a higher-priority device
        // Don't restore it until that higher-priority device is restored first
        const swappedFor = this.swappedOutFor[dev.id];
        if (swappedFor) {
          const higherPriDev = planDevices.find((d) => d.id === swappedFor);
          // If the higher-priority device is still off, don't restore this one
          if (higherPriDev && higherPriDev.currentState === 'off') {
            dev.plannedState = 'shed';
            dev.reason = `stay shed while swap target ${higherPriDev.name} restores`;
            this.logDebug(`Plan: blocking restore of ${dev.name} - was swapped out for ${higherPriDev.name} which is still off`);
            continue;
          } else {
            // Higher-priority device is now on, clear the swap tracking
            delete this.swappedOutFor[dev.id];
            this.pendingSwapTargets.delete(swappedFor);
            delete this.pendingSwapTimestamps[swappedFor];
            this.logDebug(`Plan: ${dev.name} can now be considered for restore - ${higherPriDev?.name ?? swappedFor} is restored`);
          }
        }

        // Check if there are pending swap targets with higher priority than this device
        // If so, don't restore this device - let the swap targets get restored first
        // But if THIS device is a swap target, it should be allowed to restore
        if (this.pendingSwapTargets.size > 0 && !this.pendingSwapTargets.has(dev.id)) {
          const devPriority = dev.priority ?? 100;
          let blockedBySwapTarget: { id: string; name: string; priority: number } | null = null;
          for (const swapTargetId of this.pendingSwapTargets) {
            if (swapTargetId === dev.id) continue; // Don't block ourselves
            const swapTargetDev = planDevices.find((d) => d.id === swapTargetId);
            if (swapTargetDev) {
              const swapTargetPriority = swapTargetDev.priority ?? 100;
              // If swap target has higher or equal priority, it should restore first
              if (swapTargetPriority >= devPriority && swapTargetDev.currentState === 'off') {
                blockedBySwapTarget = { id: swapTargetId, name: swapTargetDev.name, priority: swapTargetPriority };
                break;
              }
              // If swap target is now on, it's no longer pending
              if (swapTargetDev.currentState === 'on') {
                this.pendingSwapTargets.delete(swapTargetId);
                delete this.pendingSwapTimestamps[swapTargetId];
              }
            } else {
              // Device no longer exists, clean up
              this.pendingSwapTargets.delete(swapTargetId);
              delete this.pendingSwapTimestamps[swapTargetId];
            }
          }
          if (blockedBySwapTarget) {
            dev.plannedState = 'shed';
            dev.reason = `stay shed while swap target ${blockedBySwapTarget.name} restores`;
            this.logDebug(`Plan: blocking restore of ${dev.name} (p${devPriority}) - swap target ${blockedBySwapTarget.name} (p${blockedBySwapTarget.priority}) should restore first`);
            continue;
          }
        }

        // RESTORE: Use EXPECTED consumption (what we lose by restoring)
        // Fallback: measured > 0, else 1kW default
        const devPower = dev.expectedPowerKw ?? (dev.measuredPowerKw && dev.measuredPowerKw > 0 ? dev.measuredPowerKw : 1.0);
        // Need enough headroom to restore AND keep a safety buffer afterward
        const baseNeeded = devPower + restoreHysteresis;
        const needed = recentlyShed
          ? Math.max(baseNeeded * RECENT_SHED_RESTORE_MULTIPLIER, baseNeeded + RECENT_SHED_EXTRA_BUFFER_KW)
          : baseNeeded;

        if (availableHeadroom >= needed) {
          // Enough headroom - restore this device
          availableHeadroom -= needed; // Reserve the hysteresis buffer (with any extra cushion)
          restoredThisCycle.add(dev.id);
          restoredOneThisCycle = true; // Only restore one device per cycle
        } else {
          // Not enough headroom or budget - try to swap with lower priority ON devices
          const devPriority = dev.priority ?? 100;

          if (measurementTs !== null && this.lastSwapPlanMeasurementTs[dev.id] === measurementTs) {
            dev.plannedState = 'shed';
            dev.reason = 'stay off (waiting for new measurement before swap)';
            this.logDebug(`Plan: skipping ${dev.name} - waiting for new measurement before swap`);
            continue;
          }
          // Check if this device is already a pending swap target - don't re-plan the same swap
          if (this.pendingSwapTargets.has(dev.id)) {
            dev.plannedState = 'shed';
            dev.reason = 'stay off (swap already pending, waiting for execution)';
            this.logDebug(`Plan: skipping ${dev.name} - swap already pending`);
            continue;
          }

          // Force 'shed' if we are not restoring, to prevent it from turning on if desired state is ON
          // (Secondary guard mentioned in comments)
          if (dev.plannedTarget !== null || dev.currentTarget !== null) {
            dev.plannedState = 'shed';
            dev.reason = 'stay off (insufficient headroom to restore)';
          } else {
            // If no desired target, 'keep' implies staying off (current state)
            dev.reason = 'stay off (insufficient headroom)';
          }

          // Try to find a swap candidate to shed
          let potentialHeadroom = availableHeadroom;
          const toShed: typeof onDevices = [];

          for (const onDev of onDevices) {
            // Don't shed equal or higher priority devices (lower number = higher priority)
            if ((onDev.priority ?? 100) <= devPriority) break;
            if (onDev.plannedState === 'shed') continue; // Already being shed
            if (restoredThisCycle.has(onDev.id)) continue; // Don't swap out something we just decided to restore
            // Don't include devices that are already being swapped out for another target
            if (this.swappedOutFor[onDev.id]) continue;

            const onDevPower = onDev.powerKw && onDev.powerKw > 0 ? onDev.powerKw : 1;
            toShed.push(onDev);
            potentialHeadroom += onDevPower;

            if (potentialHeadroom >= needed) break; // Enough room now
          }

          if (potentialHeadroom >= needed && toShed.length > 0) {
            // Swap: shed the low-priority devices and restore the high-priority one
            // Swaps are budget-neutral (shedding creates headroom), so don't count against restore budget
            const shedNames = toShed.map((d) => d.name).join(', ');
            const shedPower = toShed.reduce((sum, d) => sum + (d.powerKw ?? 1), 0).toFixed(2);
            this.log(
              `Plan: swap approved for ${dev.name} - shedding ${shedNames} (${shedPower}kW) `
              + `to get ${potentialHeadroom.toFixed(2)}kW >= ${needed.toFixed(2)}kW needed`,
            );
            // Track this device as a pending swap target - no lower-priority device should restore first
            this.pendingSwapTargets.add(dev.id);
            this.pendingSwapTimestamps[dev.id] = Date.now();
            if (measurementTs !== null) {
              this.lastSwapPlanMeasurementTs[dev.id] = measurementTs;
            }
            for (const shedDev of toShed) {
              shedDev.plannedState = 'shed';
              shedDev.reason = `swapped out for higher priority ${dev.name} (p${devPriority})`;
              this.log(`Plan: swapping out ${shedDev.name} (p${shedDev.priority ?? 100}, ~${(shedDev.powerKw ?? 1).toFixed(2)}kW) to restore ${dev.name} (p${devPriority})`);
              availableHeadroom += shedDev.powerKw && shedDev.powerKw > 0 ? shedDev.powerKw : 1;
              // Track that this device was swapped out for the higher-priority device
              // It should not be restored until the higher-priority device is restored first
              this.swappedOutFor[shedDev.id] = dev.id;
            }
            availableHeadroom -= needed; // Reserve the hysteresis buffer (with any extra cushion) for swaps too
            restoredThisCycle.add(dev.id);
            restoredOneThisCycle = true; // Swap counts as a restore - wait for measurement
            // Note: we don't add to cumulativeRestorePower for swaps since it's net-neutral
          } else {
            // Cannot restore - not enough headroom even with swaps
            dev.plannedState = 'shed';
            const recentNote = recentlyShed ? ' (recently shed)' : '';
            dev.reason = `stay shed due to insufficient headroom${recentNote} (no lower-priority devices to swap)`;
            this.logDebug(`Plan: skipping restore of ${dev.name} (p${dev.priority ?? 100}, ~${devPower.toFixed(2)}kW) - ${dev.reason}`);
          }
        }
      }
    } else if (headroomRaw !== null && (sheddingActive || inCooldown || inRestoreCooldown)) {
      // Shedding active, in cooldown, or waiting for power to stabilize - mark all off devices to stay off
      const offDevices = planDevices
        .filter((d) => d.controllable !== false && d.currentState === 'off' && d.plannedState !== 'shed');
      for (const dev of offDevices) {
        dev.plannedState = 'shed';
        const defaultReason = shedReasons.get(dev.id) || 'shed due to capacity';
        // eslint-disable-next-line no-nested-ternary -- Clear state-dependent reason selection
        dev.reason = activeOvershoot
          ? defaultReason
          : sheddingActive
            ? 'stay off while shedding is active'
            : inCooldown
              ? `stay off during cooldown (${(cooldownRemainingMs / 1000).toFixed(1)}s remaining)`
              : `stay off (waiting for power to stabilize after last restore, ${Math.max(0, RESTORE_COOLDOWN_MS - (sinceRestore ?? 0)) / 1000}s remaining)`;
        this.logDebug(`Plan: skipping restore of ${dev.name} (p${dev.priority ?? 100}, ~${(dev.powerKw ?? 1).toFixed(2)}kW) - ${dev.reason}`);
      }
    }

    const inShedWindow = sheddingActive || inCooldown || activeOvershoot || inRestoreCooldown;
    const shedCooldownRemainingMs = Math.min(
      sinceShedding !== null ? Math.max(0, SHED_COOLDOWN_MS - sinceShedding) : Number.POSITIVE_INFINITY,
      sinceOvershoot !== null ? Math.max(0, SHED_COOLDOWN_MS - sinceOvershoot) : Number.POSITIVE_INFINITY,
    );
    const shedCooldownRemainingSec = Number.isFinite(shedCooldownRemainingMs)
      ? Math.ceil(shedCooldownRemainingMs / 1000)
      : null;
    const restoreCooldownRemainingMs = sinceRestore !== null ? Math.max(0, RESTORE_COOLDOWN_MS - sinceRestore) : null;
    const restoreCooldownRemainingSec = restoreCooldownRemainingMs !== null ? Math.ceil(restoreCooldownRemainingMs / 1000) : null;

    // Second pass: if a device is at its configured shed temperature and we're still in/just after overshoot,
    // keep it marked as shed so the plan reflects the min-temp shedding state.
    for (const dev of planDevices) {
      const behavior = this.getShedBehavior(dev.id);
      if (behavior.action !== 'set_temperature' || behavior.temperature === null) continue;
      const atMinTemp = Number(dev.currentTarget) === behavior.temperature || Number(dev.plannedTarget) === behavior.temperature;
      const alreadyMinTempShed = dev.shedAction === 'set_temperature' && dev.shedTemperature === behavior.temperature;
      const wasShedLastPlan = this.lastPlannedShedIds.has(dev.id);
      const holdDuringRestoreCooldown = sinceRestore !== null && sinceRestore < RESTORE_COOLDOWN_MS;
      const shouldHoldShed = (inShedWindow || holdDuringRestoreCooldown)
        && (dev.plannedState === 'shed' || atMinTemp || alreadyMinTempShed || wasShedLastPlan);

      let finalHoldShed = shouldHoldShed;

      // If logic says we can release the shed (restore), verify we have enough headroom and haven't restored another device yet.
      if (!finalHoldShed && wasShedLastPlan) {
        // We don't know the exact power increase of restoring the temperature, but we should at least ensure we have the safety buffer.
        const needed = restoreHysteresis;
        if (availableHeadroom < needed) {
          finalHoldShed = true;
          dev.reason = 'stay shed (insufficient headroom to restore)';
        } else if (restoredOneThisCycle) {
          finalHoldShed = true;
          dev.reason = 'stay shed (throttled restore: one device per cycle)';
        } else {
          // Creating a restore event
          restoredOneThisCycle = true;
          availableHeadroom -= needed;
          restoredThisCycle.add(dev.id);
        }
      }

      if (finalHoldShed) {
        dev.plannedState = 'shed';
        dev.shedAction = 'set_temperature';
        dev.shedTemperature = behavior.temperature;
        dev.plannedTarget = behavior.temperature;
        const isSwapReason = typeof dev.reason === 'string'
          && (dev.reason.includes('swapped out') || dev.reason.includes('swap target'));
        const hasSpecialReason = typeof dev.reason === 'string'
          && (dev.reason.includes('shortfall') || isSwapReason || dev.reason.includes('hourly energy budget'));
        const baseReason = shedReasons.get(dev.id)
          || (hasSpecialReason && dev.reason)
          || 'shed due to capacity';
        const useCooldownReason = inCooldown && !activeOvershoot && !dev.reason?.includes('swap');
        dev.reason = useCooldownReason
          ? `stay shed during cooldown before restore${shedCooldownRemainingSec !== null ? ` (${shedCooldownRemainingSec}s remaining)` : ''}`
          : baseReason;
      }
    }

    // If we planned any restorations this cycle, start the restore cooldown immediately to avoid racing
    // with the async applyPlanActions(). This keeps subsequent plans from restoring multiple devices
    // in back-to-back cycles.
    if (restoredThisCycle.size > 0) {
      this.lastRestoreMs = Date.now();
    }

    // Standardize shed reasons so min-temp and turn-off behaviors report the same states.
    for (const dev of planDevices) {
      if (dev.plannedState !== 'shed') continue;
      const isSwapReason = dev.reason?.includes('swap target') || dev.reason?.includes('swapped out');
      const isBudgetReason = dev.reason?.includes('hourly energy budget');
      const isShortfallReason = dev.reason?.includes('shortfall');
      const keepReason = dev.reason
        && !dev.reason.startsWith('keep (')
        && !dev.reason.startsWith('restore (need')
        && !(dev.shedAction === 'set_temperature' && dev.reason.startsWith('stay off'))
        && !dev.reason.startsWith('set to ')
        ? dev.reason
        : null;
      const baseReason = shedReasons.get(dev.id) || keepReason || 'shed due to capacity';

      if (guardInShortfall && !isSwapReason && !isBudgetReason) {
        dev.reason = dev.shedAction === 'set_temperature'
          ? 'temperature lowered while in capacity shortfall'
          : 'stay off while in capacity shortfall';
        continue;
      }
      if (inCooldown && !activeOvershoot && !isSwapReason) {
        dev.reason = `stay shed during cooldown before restore${shedCooldownRemainingSec !== null ? ` (${shedCooldownRemainingSec}s remaining)` : ''}`;
        continue;
      }
      if (inRestoreCooldown && !isSwapReason && !isBudgetReason && !isShortfallReason) {
        dev.reason = `stay shed while power stabilizes${restoreCooldownRemainingSec !== null ? ` (${restoreCooldownRemainingSec}s remaining)` : ''}`;
        continue;
      }
      const shouldNormalizeReason = (
        !dev.reason
        || dev.reason.startsWith('keep (')
        || dev.reason.startsWith('restore (need')
        || dev.reason.startsWith('set to ')
        || (dev.shedAction === 'set_temperature' && dev.reason.startsWith('stay off'))
      );
      if (shouldNormalizeReason) {
        dev.reason = baseReason;
      }
    }

    // Sort devices by priority ascending (priority 1 = most important, shown first)
    planDevices.sort((a, b) => (a.priority ?? 999) - (b.priority ?? 999));

    this.lastPlannedShedIds = new Set(planDevices.filter((d) => d.plannedState === 'shed').map((d) => d.id));

    return {
      meta: {
        totalKw: total,
        softLimitKw: softLimit,
        headroomKw: headroom,
        hourlyBudgetExhausted: this.hourlyBudgetExhausted,
        usedKWh,
        budgetKWh,
        minutesRemaining,
      },
      devices: planDevices,
    };
  }



  private getPriorityForDevice(deviceId: string): number {
    const mode = this.operatingMode || 'Home';
    return this.capacityPriorities[mode]?.[deviceId] ?? 100;
  }

  private resolveModeName(name: string): string {
    const current = (name || '').trim();
    const mapped = this.modeAliases[current.toLowerCase()];
    if (typeof mapped === 'string' && mapped.trim()) return mapped;
    return current;
  }

  private getAllModes(): Set<string> {
    const modes = new Set<string>();
    if (this.operatingMode) modes.add(this.operatingMode);
    Object.keys(this.capacityPriorities || {}).forEach((m) => {
      if (m && m.trim()) modes.add(m);
    });
    Object.keys(this.modeDeviceTargets || {}).forEach((m) => {
      if (m && m.trim()) modes.add(m);
    });
    return modes;
  }

  private normalizeShedBehaviors(input: unknown): Record<string, ShedBehavior> {
    if (!this.isRecord(input)) return {};
    const result: Record<string, ShedBehavior> = {};
    for (const deviceId of Object.keys(input)) {
      const raw = input[deviceId];
      if (!raw || typeof raw !== 'object') continue;
      const candidate = raw as { action?: unknown; temperature?: unknown };
      const action: ShedAction = candidate.action === 'set_temperature' ? 'set_temperature' : 'turn_off';
      const tempRaw = candidate.temperature;
      const temperature = typeof tempRaw === 'number' && Number.isFinite(tempRaw)
        ? Math.max(-50, Math.min(50, tempRaw))
        : undefined;
      result[deviceId] = action === 'set_temperature' && typeof temperature === 'number'
        ? { action, temperature }
        : { action };
    }
    return result;
  }

  private getShedBehavior(deviceId: string): { action: ShedAction; temperature: number | null } {
    const behavior = this.shedBehaviors[deviceId];
    const action: ShedAction = behavior?.action === 'set_temperature' ? 'set_temperature' : 'turn_off';
    const temp = behavior?.temperature;
    const temperature = Number.isFinite(temp) ? Math.max(-50, Math.min(50, Number(temp))) : null;
    return { action, temperature };
  }

  private isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
  }

  private computeDynamicSoftLimit(): number {
    const budgetKw = this.capacitySettings.limitKw;
    const { marginKw } = this.capacitySettings;
    const netBudgetKWh = Math.max(0, budgetKw - marginKw);
    if (netBudgetKWh <= 0) return 0;

    const now = Date.now();
    const date = new Date(now);
    date.setMinutes(0, 0, 0);
    const hourStart = date.getTime();
    const hourEnd = hourStart + 60 * 60 * 1000;
    const remainingMs = hourEnd - now;
    const remainingHours = Math.max(remainingMs / 3600000, 10 / 60); // floor at 10 minutes to avoid extreme burst rates

    const bucketKey = new Date(hourStart).toISOString();
    const usedKWh = this.powerTracker.buckets?.[bucketKey] || 0;
    const remainingKWh = Math.max(0, netBudgetKWh - usedKWh);
    this.hourlyBudgetExhausted = remainingKWh <= 0;

    // Calculate instantaneous rate needed to use remaining budget
    const burstRateKw = remainingKWh / remainingHours;

    // Only cap to sustainable rate in the last 10 minutes of the hour.
    // This prevents the "end of hour burst" problem where devices ramp up
    // to use remaining budget, then immediately overshoot the next hour.
    // Earlier in the hour, allow the full burst rate since there's time to recover.
    const minutesRemaining = remainingMs / 60000;
    const sustainableRateKw = netBudgetKWh; // kWh/h = kW at steady state
    const allowedKw = minutesRemaining <= 10 ? Math.min(burstRateKw, sustainableRateKw) : burstRateKw;

    this.logDebug(
      `Soft limit calc: budget=${netBudgetKWh.toFixed(3)}kWh used=${usedKWh.toFixed(3)}kWh `
      + `remaining=${remainingKWh.toFixed(3)}kWh timeLeft=${remainingHours.toFixed(3)}h `
      + `burst=${burstRateKw.toFixed(3)}kW capped=${allowedKw.toFixed(3)}kW`,
    );
    return allowedKw;
  }

  /**
   * Compute the shortfall threshold - the "real" soft limit without EOH capping.
   * Shortfall should only trigger when power exceeds this threshold AND no devices left to shed.
   * During end-of-hour, the soft limit for shedding is artificially lowered to prepare
   * for the next hour, but we shouldn't alert shortfall just because of that constraint.
   */
  private computeShortfallThreshold(): number {
    const budgetKw = this.capacitySettings.limitKw;
    const { marginKw } = this.capacitySettings;
    const netBudgetKWh = Math.max(0, budgetKw - marginKw);
    if (netBudgetKWh <= 0) return 0;

    const now = Date.now();
    const date = new Date(now);
    date.setMinutes(0, 0, 0);
    const hourStart = date.getTime();
    const hourEnd = hourStart + 60 * 60 * 1000;
    const remainingMs = hourEnd - now;
    const remainingHours = Math.max(remainingMs / 3600000, 0.01);

    const bucketKey = new Date(hourStart).toISOString();
    const usedKWh = this.powerTracker.buckets?.[bucketKey] || 0;
    const remainingKWh = Math.max(0, netBudgetKWh - usedKWh);

    // Return the uncapped burst rate - this is the actual limit before we'd exceed hourly budget
    return remainingKWh / remainingHours;
  }

  private async applySheddingToDevice(deviceId: string, deviceName?: string, reason?: string): Promise<void> {
    if (this.capacityDryRun) return;
    const now = Date.now();
    const lastForDevice = this.lastDeviceShedMs[deviceId];
    const throttleMs = 5000;
    if (lastForDevice && now - lastForDevice < throttleMs) {
      this.logDebug(
        `Actuator: skip shedding ${deviceName || deviceId}, throttled (${now - lastForDevice}ms since last)`,
      );
      return;
    }
    // Check if this device is already being shed (in-flight)
    if (this.pendingSheds.has(deviceId)) {
      this.logDebug(`Actuator: skip shedding ${deviceName || deviceId}, already in progress`);
      return;
    }
    const snapshotState = this.latestTargetSnapshot.find((d) => d.id === deviceId);
    if (snapshotState && snapshotState.currentOn === false) {
      this.logDebug(`Actuator: skip shedding ${deviceName || deviceId}, already off in snapshot`);
      return;
    }
    const shedBehavior = this.getShedBehavior(deviceId);
    const targetCap = snapshotState?.targets?.[0]?.id;
    const shedTemp = shedBehavior.action === 'set_temperature' && shedBehavior.temperature !== null
      ? shedBehavior.temperature
      : null;
    const canSetShedTemp = Boolean(targetCap && shedTemp !== null);
    const name = deviceName || deviceId;
    // Mark as pending before async operation
    this.pendingSheds.add(deviceId);
    try {
      if (canSetShedTemp) {
        try {
          await this.deviceManager.setCapability(deviceId, targetCap!, shedTemp as number);
          this.log(`Capacity: set ${targetCap} for ${name} to ${shedTemp}°C (shedding)`);
          this.updateLocalSnapshot(deviceId, { target: shedTemp as number });
          this.lastSheddingMs = now;
          this.lastOvershootMs = now;
          this.lastDeviceShedMs[deviceId] = now;
          return;
        } catch (error) {
          this.error(`Failed to set shed temperature for ${name} via DeviceManager`, error);
          // Fall through to power off as a fallback
        }
      }
      try {
        await this.deviceManager.setCapability(deviceId, 'onoff', false);

        this.log(`Capacity: turned off ${name} (${reason || 'shedding'})`);
        this.updateLocalSnapshot(deviceId, { on: false });
        this.lastSheddingMs = now;
        this.lastDeviceShedMs[deviceId] = now;
      } catch (error) {
        this.error(`Failed to turn off ${name} via DeviceManager`, error);
      }
    } finally {
      this.pendingSheds.delete(deviceId);
    }
  }

  private async handleShortfall(deficitKw: number): Promise<void> {
    if (this.inShortfall) return; // Already in shortfall state

    const softLimit = this.capacityGuard ? this.capacityGuard.getSoftLimit() : this.capacitySettings.limitKw;
    const total = this.capacityGuard ? this.capacityGuard.getLastTotalPower() : null;

    this.log(`Capacity shortfall: cannot reach soft limit, deficit ~${deficitKw.toFixed(2)}kW (total ${total === null ? 'unknown' : total.toFixed(2)
      }kW, soft ${softLimit.toFixed(2)}kW)`);

    this.inShortfall = true;
    this.homey.settings.set('capacity_in_shortfall', true);

    // Create timeline notification
    this.homey.notifications.createNotification({
      excerpt: `Capacity shortfall: **${deficitKw.toFixed(2)} kW** over limit. Manual action may be needed.`,
    }).catch((err: Error) => this.error('Failed to create shortfall notification', err));

    // Trigger flow card
    const card = this.homey.flow?.getTriggerCard?.('capacity_shortfall');
    if (card && typeof card.trigger === 'function') {
      card.trigger({}).catch((err: Error) => this.error('Failed to trigger capacity_shortfall', err));
    }
  }

  private async handleShortfallCleared(): Promise<void> {
    if (!this.inShortfall) return; // Not in shortfall state

    this.log('Capacity shortfall resolved');
    this.inShortfall = false;
    this.homey.settings.set('capacity_in_shortfall', false);

    // Create timeline notification
    this.homey.notifications.createNotification({
      excerpt: 'Capacity shortfall **resolved**. Load is back within limits.',
    }).catch((err: Error) => this.error('Failed to create shortfall cleared notification', err));
  }

  // eslint-disable-next-line max-len -- Plan structure has dynamic target values
  private async applyPlanActions(plan: DevicePlan): Promise<void> {
    if (!plan || !Array.isArray(plan.devices)) return;

    for (const dev of plan.devices) {
      const shedAction = dev.shedAction ?? 'turn_off';
      if (dev.controllable === false) continue;
      // Apply on/off when shedding.
      if (dev.plannedState === 'shed') {
        if (shedAction === 'set_temperature') {
          const snapshotEntry = this.latestTargetSnapshot.find((d) => d.id === dev.id);
          const currentSnapshotTarget = snapshotEntry?.targets?.[0]?.value;
          const targetCap = snapshotEntry?.targets?.[0]?.id;
          if (this.capacityDryRun) {
            this.log(`Capacity (dry run): would set ${targetCap || 'target'} for ${dev.name || dev.id} to ${dev.plannedTarget ?? '–'}°C (overshoot)`);
            continue;
          }
          const currentTarget = typeof currentSnapshotTarget === 'number' ? currentSnapshotTarget : dev.currentTarget;
          const alreadyAtTarget = typeof currentTarget === 'number'
            && typeof dev.plannedTarget === 'number'
            && currentTarget === dev.plannedTarget;
          if (alreadyAtTarget) {
            this.logDebug(`Capacity: skip setting ${targetCap || 'target'} for ${dev.name || dev.id}, already at ${dev.plannedTarget}°C`);
            continue;
          }
          if (targetCap && typeof dev.plannedTarget === 'number') {
            try {
              await this.deviceManager.setCapability(dev.id, targetCap, dev.plannedTarget);
              this.log(`Capacity: set ${targetCap} for ${dev.name || dev.id} to ${dev.plannedTarget}°C (overshoot)`);
              this.updateLocalSnapshot(dev.id, { target: dev.plannedTarget });
              const now = Date.now();
              this.lastDeviceShedMs[dev.id] = now;
              const guardShedding = this.capacityGuard?.isSheddingActive?.() === true;
              const guardHeadroom = this.capacityGuard?.getHeadroom?.();
              if (guardShedding || (typeof guardHeadroom === 'number' && guardHeadroom < 0)) {
                this.lastSheddingMs = now;
                this.lastOvershootMs = now;
              }
            } catch (error) {
              this.error(`Failed to set overshoot temperature for ${dev.name || dev.id} via DeviceManager`, error);
            }
          }
          continue;
        }
        if (dev.currentState !== 'off') {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Dev reason is dynamically added
          const { reason } = dev as any;
          const isSwap = reason && reason.includes('swapped out for');
          await this.applySheddingToDevice(dev.id, dev.name, isSwap ? reason : undefined);
        }
        continue;
      }
      // Restore power if the plan keeps it on and it was off.
      if (dev.plannedState !== 'shed' && dev.currentState === 'off') {
        const name = dev.name || dev.id;
        // Check if this device is already being restored (in-flight)
        if (this.pendingRestores.has(dev.id)) {
          this.logDebug(`Capacity: skip restoring ${name}, already in progress`);
          continue;
        }
        // Skip turning back on unless we have some headroom to avoid flapping.
        const headroom = this.capacityGuard ? this.capacityGuard.getHeadroom() : null;
        const sheddingActive = this.capacityGuard?.isSheddingActive() === true;
        const inShortfall = this.capacityGuard?.isInShortfall() === true;
        const restoreMargin = Math.max(0.1, this.capacitySettings.marginKw || 0);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Device power is dynamically available
        const plannedPower = (dev as any).powerKw && (dev as any).powerKw > 0 ? (dev as any).powerKw : 1;
        const extraBuffer = Math.max(0.2, restoreMargin); // add a little hysteresis for restores
        const baseNeededForDevice = plannedPower + restoreMargin + extraBuffer;
        const lastDeviceShed = this.lastDeviceShedMs[dev.id];
        const recentlyShed = Boolean(
          lastDeviceShed && Date.now() - lastDeviceShed < RECENT_SHED_RESTORE_BACKOFF_MS,
        );
        const neededForDevice = recentlyShed
          ? Math.max(baseNeededForDevice * RECENT_SHED_RESTORE_MULTIPLIER, baseNeededForDevice + RECENT_SHED_EXTRA_BUFFER_KW)
          : baseNeededForDevice;
        const { cooldownRemainingMs, inCooldown } = this.getCooldownState();
        // Do not restore devices while shedding is active, in shortfall, during cooldown, when headroom is unknown or near zero,
        // or when there is insufficient headroom for this device plus buffers.
        // Note: We don't need a separate "restore budget" because:
        // 1. The plan already limits to ONE restore per cycle (restoredOneThisCycle)
        // 2. 30-second restore cooldown prevents rapid successive restores
        // 3. headroom < neededForDevice ensures we have enough margin
        if (sheddingActive || inShortfall || inCooldown || headroom === null || headroom <= 0 || headroom < neededForDevice) {
          /* eslint-disable no-nested-ternary, max-len -- Clear state-dependent reason logging */
          const reason = sheddingActive
            ? 'shedding active'
            : inShortfall
              ? 'in shortfall'
            : inCooldown
              ? `cooldown (${(cooldownRemainingMs / 1000).toFixed(1)}s remaining)`
              : recentlyShed
                ? 'recently shed, waiting for stable headroom'
                : 'insufficient headroom';
          this.log(`Capacity: keeping ${name} off (${reason})`);
          this.logDebug(
            `  → need ${neededForDevice.toFixed(2)}kW, headroom ${headroom === null ? 'unknown' : headroom.toFixed(2)}kW, device ~${plannedPower.toFixed(2)}kW`,
          );
          /* eslint-enable no-nested-ternary, max-len */
          continue;
        }
        // Mark as pending before async operation
        this.pendingRestores.add(dev.id);
        try {
          try {
            await this.deviceManager.setCapability(dev.id, 'onoff', true);
            this.log(`Capacity: turning on ${name} (restored from shed/off state)`);
            this.lastRestoreMs = Date.now(); // Track when we restored so we can wait for power to stabilize
            this.lastDeviceRestoreMs[dev.id] = this.lastRestoreMs;
            // Clear this device from pending swap targets if it was one
            this.pendingSwapTargets.delete(dev.id);
            delete this.pendingSwapTimestamps[dev.id];
          } catch (error) {
            this.error(`Failed to turn on ${name} via DeviceManager`, error);
          }
        } finally {
          this.pendingRestores.delete(dev.id);
        }
      }

      // Apply target temperature changes.
      if (typeof dev.plannedTarget === 'number' && dev.plannedTarget !== dev.currentTarget) {
        const snapshot = this.latestTargetSnapshot.find((d) => d.id === dev.id);
        const targetCap = snapshot?.targets?.[0]?.id;
        if (!targetCap) continue;

        // Check if this is a restoration (increasing temperature from shed state)
        const currentIsNumber = typeof dev.currentTarget === 'number';
        const shedBehavior = this.getShedBehavior(dev.id);
        const wasAtShedTemp = currentIsNumber && shedBehavior.action === 'set_temperature'
          && shedBehavior.temperature !== null && dev.currentTarget === shedBehavior.temperature;
        const isRestoring = wasAtShedTemp && dev.plannedTarget > (dev.currentTarget as number);

        try {
          await this.deviceManager.setCapability(dev.id, targetCap, dev.plannedTarget);
          const fromStr = dev.currentTarget === undefined || dev.currentTarget === null
            ? ''
            : `from ${dev.currentTarget} `;
          this.log(
            `Set ${targetCap} for ${dev.name || dev.id} ${fromStr}to ${dev.plannedTarget} (mode: ${this.operatingMode})`,
          );
          this.updateLocalSnapshot(dev.id, { target: dev.plannedTarget });

          // If this was a restoration from shed temperature, update lastRestoreMs
          // This ensures cooldown applies between restoring different devices
          if (isRestoring) {
            this.lastRestoreMs = Date.now();
            this.lastDeviceRestoreMs[dev.id] = this.lastRestoreMs;
          }
        } catch (error) {
          this.error(`Failed to set ${targetCap} for ${dev.name || dev.id} via DeviceManager`, error);
        }
      }
    }
  }
}
