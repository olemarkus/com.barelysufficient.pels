import Homey from 'homey';
import https from 'https';
// eslint-disable-next-line @typescript-eslint/no-var-requires
// eslint-disable-next-line import/no-unresolved, import/extensions, node/no-missing-import
import CapacityGuard from './capacityGuard';

const { HomeyAPI } = require('homey-api');

const TARGET_CAPABILITY_PREFIXES = ['target_temperature', 'thermostat_setpoint'];
const DEBUG_LOG = false;

// Timing constants for shedding/restore behavior
const SHED_COOLDOWN_MS = 60000; // Wait 60s after shedding before considering restores
const RESTORE_COOLDOWN_MS = 30000; // Wait 30s after restore for power to stabilize
const SWAP_TIMEOUT_MS = 60000; // Clear pending swaps after 60s if they couldn't complete
const SNAPSHOT_REFRESH_INTERVAL_MS = 5 * 60 * 1000; // Refresh device snapshot every 5 minutes

// Power thresholds
const MIN_SIGNIFICANT_POWER_W = 50; // Minimum power draw to consider "on" or worth tracking

module.exports = class PelsApp extends Homey.App {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Homey API has no TypeScript definitions
  private homeyApi?: any;
  private powerTracker: {
    lastPowerW?: number;
    lastTimestamp?: number;
    buckets?: Record<string, number>;
  } = {};

  private capacityGuard?: CapacityGuard;
  private capacitySettings = {
    limitKw: 10,
    marginKw: 0.2,
  };

  private capacityDryRun = true;
  private capacityMode = 'Home';
  private capacityPriorities: Record<string, Record<string, number>> = {};
  private modeDeviceTargets: Record<string, Record<string, number>> = {};
  private controllableDevices: Record<string, boolean> = {};
  private lastDeviceShedMs: Record<string, number> = {};
  private pendingSheds = new Set<string>(); // Devices currently being shed (in-flight)
  private pendingRestores = new Set<string>(); // Devices currently being restored (in-flight)
  private lastSheddingMs: number | null = null;
  private lastOvershootMs: number | null = null;
  private lastRestoreMs: number | null = null; // Track when we last restored a device
  // Track devices that were swapped out: swappedOutDeviceId -> higherPriorityDeviceId
  // These devices should not be restored until the higher-priority device they were swapped for is restored
  private swappedOutFor: Record<string, string> = {};
  // Track devices that are swap targets (higher-priority devices waiting to restore via swap)
  // No device with lower priority than a pending swap target should restore first
  private pendingSwapTargets: Set<string> = new Set();
  // Track when each swap was initiated - used to timeout stale swaps
  private pendingSwapTimestamps: Record<string, number> = {};
  private latestTargetSnapshot: Array<{
    id: string;
    name: string;
    targets: Array<{ id: string; value: unknown; unit: string }>;
    powerKw?: number;
    priority?: number;
    currentOn?: boolean;
    zone?: string;
    controllable?: boolean;
  }> = [];

  private lastPlanSignature = '';
  private snapshotRefreshInterval?: ReturnType<typeof setInterval>;
  private priceRefreshInterval?: ReturnType<typeof setInterval>;
  private priceOptimizationInterval?: ReturnType<typeof setInterval>;
  // Set when remaining hourly energy budget has been fully consumed (remainingKWh <= 0)
  private hourlyBudgetExhausted = false;
  // Track last known power draw (kW) for each device when it was ON and drawing power > 0
  // Used as a fallback estimate when settings.load is not available
  private lastKnownPowerKw: Record<string, number> = {};
  // Price optimization settings per device: { deviceId: { enabled, cheapDelta, expensiveDelta } }
  private priceOptimizationSettings: Record<string, {
    enabled: boolean;
    cheapDelta: number;
    expensiveDelta: number;
  }> = {};

  private updateLocalSnapshot(deviceId: string, updates: { target?: number | null; on?: boolean }): void {
    const snap = this.latestTargetSnapshot.find((d) => d.id === deviceId);
    if (!snap) return;
    if (typeof updates.target === 'number') {
      if (snap.targets && snap.targets[0]) {
        snap.targets[0].value = updates.target;
      }
    }
    if (typeof updates.on === 'boolean') {
      snap.currentOn = updates.on;
      // Keep Guard in sync with on/off state changes
      this.syncGuardFromSnapshot(this.latestTargetSnapshot);
    }
  }

  /**
   * onInit is called when the app is initialized.
   */
  async onInit() {
    this.log('PELS has been initialized');

    this.homey.settings.on('set', (key: string) => {
      if (key === 'mode_device_targets' || key === 'capacity_mode') {
        const newMode = this.homey.settings.get('capacity_mode');
        if (typeof newMode === 'string' && newMode.trim()) {
          this.capacityMode = newMode;
        }
        this.loadCapacitySettings();
        this.applyDeviceTargetsForMode(this.capacityMode).catch((error: Error) => {
          this.error('Failed to apply per-mode device targets', error);
        });
        this.rebuildPlanFromCache();
        return;
      }

      if (key === 'capacity_priorities') {
        this.loadCapacitySettings();
        this.rebuildPlanFromCache();
        return;
      }

      if (key === 'controllable_devices') {
        this.loadCapacitySettings();
        this.refreshTargetDevicesSnapshot().catch((error: Error) => {
          this.error('Failed to refresh devices after controllable change', error);
        });
        return;
      }

      if (key === 'power_tracker_state') {
        // Only reload state; recordPowerSample() already calls rebuildPlanFromCache()
        // so we don't need to call it again here (avoids duplicate plan rebuilds)
        this.loadPowerTracker();
        return;
      }

      if (key === 'capacity_limit_kw' || key === 'capacity_margin_kw') {
        this.loadCapacitySettings();
        if (this.capacityGuard) {
          this.capacityGuard.setLimit(this.capacitySettings.limitKw);
          this.capacityGuard.setSoftMargin(this.capacitySettings.marginKw);
        }
        this.rebuildPlanFromCache();
        return;
      }

      if (key === 'capacity_dry_run') {
        this.loadCapacitySettings();
        if (this.capacityGuard) {
          this.capacityGuard.setDryRun(this.capacityDryRun);
        }
        this.rebuildPlanFromCache();
        return;
      }

      if (key === 'refresh_target_devices_snapshot') {
        this.refreshTargetDevicesSnapshot().catch((error: Error) => {
          this.error('Failed to refresh target devices snapshot', error);
        });
      }

      if (key === 'refresh_nettleie') {
        this.refreshNettleieData(true).catch((error: Error) => {
          this.error('Failed to refresh nettleie data', error);
        });
      }

      if (key === 'refresh_spot_prices') {
        this.refreshSpotPrices(true).catch((error: Error) => {
          this.error('Failed to refresh spot prices', error);
        });
      }

      if (key === 'price_optimization_settings') {
        this.loadPriceOptimizationSettings();
        this.refreshTargetDevicesSnapshot().catch((error: Error) => {
          this.error('Failed to refresh plan after price optimization settings change', error);
        });
      }
    });

    this.loadCapacitySettings();
    await this.initHomeyApi();
    this.capacityGuard = new CapacityGuard({
      limitKw: this.capacitySettings.limitKw,
      softMarginKw: this.capacitySettings.marginKw,
      dryRun: this.capacityDryRun,
      actuator: async (deviceId, deviceName) => {
        await this.applySheddingToDevice(deviceId, deviceName);
      },
      log: (...args) => this.log(...args),
      errorLog: (...args) => this.error(...args),
    });
    this.capacityGuard.setSoftLimitProvider(() => this.computeDynamicSoftLimit());
    this.capacityGuard.start();
    this.loadPowerTracker();
    this.loadPriceOptimizationSettings();
    await this.refreshTargetDevicesSnapshot();
    this.rebuildPlanFromCache(); // Build initial plan after snapshot is loaded
    await this.applyDeviceTargetsForMode(this.capacityMode);
    this.registerFlowCards();
    this.startPeriodicSnapshotRefresh();
    // Refresh prices (will use cache if we have today's data, and update combined_prices)
    await this.refreshSpotPrices();
    await this.refreshNettleieData();
    this.startPriceRefresh();
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
    if (this.priceRefreshInterval) {
      clearInterval(this.priceRefreshInterval);
      this.priceRefreshInterval = undefined;
    }
    if (this.priceOptimizationInterval) {
      clearInterval(this.priceOptimizationInterval);
      this.priceOptimizationInterval = undefined;
    }
    if (this.capacityGuard) {
      this.capacityGuard.stop();
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Debug logging accepts any arguments
  private logDebug(...args: any[]): void {
    if (DEBUG_LOG) this.log(...args);
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
    const mode = this.homey.settings.get('capacity_mode');
    const priorities = this.homey.settings.get('capacity_priorities');
    const modeTargets = this.homey.settings.get('mode_device_targets');
    const dryRun = this.homey.settings.get('capacity_dry_run');
    const controllables = this.homey.settings.get('controllable_devices');
    if (Number.isFinite(limit)) this.capacitySettings.limitKw = Number(limit);
    if (Number.isFinite(margin)) this.capacitySettings.marginKw = Number(margin);
    if (typeof mode === 'string' && mode.length > 0) this.capacityMode = mode;
    if (priorities && typeof priorities === 'object') this.capacityPriorities = priorities as Record<string, Record<string, number>>;
    if (modeTargets && typeof modeTargets === 'object') this.modeDeviceTargets = modeTargets as Record<string, Record<string, number>>;
    if (typeof dryRun === 'boolean') this.capacityDryRun = dryRun;
    if (controllables && typeof controllables === 'object') this.controllableDevices = controllables as Record<string, boolean>;
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

  private savePowerTracker(): void {
    this.homey.settings.set('power_tracker_state', this.powerTracker);
  }

  private truncateToHour(timestamp: number): number {
    const date = new Date(timestamp);
    date.setMinutes(0, 0, 0);
    return date.getTime();
  }

  private async recordPowerSample(currentPowerW: number, nowMs: number = Date.now()): Promise<void> {
    const state = this.powerTracker;
    state.buckets = state.buckets || {};

    if (typeof state.lastTimestamp !== 'number' || typeof state.lastPowerW !== 'number') {
      state.lastTimestamp = nowMs;
      state.lastPowerW = currentPowerW;
      if (this.capacityGuard) this.capacityGuard.reportTotalPower(currentPowerW / 1000);
      this.savePowerTracker();
      this.rebuildPlanFromCache();
      return;
    }

    const previousTs = state.lastTimestamp;
    const previousPower = state.lastPowerW;
    let remainingMs = nowMs - previousTs;
    let currentTs = previousTs;

    while (remainingMs > 0) {
      const hourStart = this.truncateToHour(currentTs);
      const hourEnd = hourStart + 60 * 60 * 1000;
      const segmentMs = Math.min(remainingMs, hourEnd - currentTs);
      // previousPower is in W; convert to kWh for the elapsed segment.
      const energyKWh = (previousPower / 1000) * (segmentMs / 3600000);
      const bucketKey = new Date(hourStart).toISOString();
      state.buckets[bucketKey] = (state.buckets[bucketKey] || 0) + energyKWh;

      remainingMs -= segmentMs;
      currentTs += segmentMs;
    }

    state.lastTimestamp = nowMs;
    state.lastPowerW = currentPowerW;
    if (this.capacityGuard) this.capacityGuard.reportTotalPower(currentPowerW / 1000);
    this.rebuildPlanFromCache();
    this.savePowerTracker();
  }

  private async initHomeyApi(): Promise<void> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Homey API has no TypeScript definitions
    if (!this.homey.api || typeof (this.homey.api as any).getOwnerApiToken !== 'function') {
      this.logDebug('Homey API token unavailable, skipping HomeyAPI client init');
      return;
    }

    try {
      this.homeyApi = await HomeyAPI.createAppAPI({ homey: this.homey });
      this.logDebug('Homey API client initialized');
    } catch (error) {
      this.error('Failed to initialize Homey API client', error);
      this.homeyApi = undefined;
    }
  }

  private registerFlowCards(): void {
    const reportPowerCard = this.homey.flow.getActionCard('report_power_usage');
    reportPowerCard.registerRunListener(async (args: { power: number }) => {
      const power = Number(args.power);
      if (!Number.isFinite(power) || power < 0) {
        throw new Error('Power must be a non-negative number (W).');
      }
      await this.recordPowerSample(power);
      return true;
    });

    const setLimitCard = this.homey.flow.getActionCard('set_capacity_limit');
    // eslint-disable-next-line camelcase -- Homey Flow card argument names use snake_case
    setLimitCard.registerRunListener(async (args: { limit_kw: number }) => {
      if (!this.capacityGuard) return false;
      const limit = Number(args.limit_kw);
      if (!Number.isFinite(limit) || limit <= 0) {
        throw new Error('Limit must be a positive number (kW).');
      }
      this.capacityGuard.setLimit(limit);
      return true;
    });

    const setCapacityMode = this.homey.flow.getActionCard('set_capacity_mode');
    setCapacityMode.registerRunListener(async (args: { mode: string | { id: string; name: string } }) => {
      // Handle both string (manual input) and object (autocomplete selection) formats
      const modeValue = typeof args.mode === 'object' && args.mode !== null ? args.mode.id : args.mode;
      const chosen = (modeValue || '').trim();
      if (!chosen) throw new Error('Mode must be provided');
      this.capacityMode = chosen;
      this.homey.settings.set('capacity_mode', chosen);
      // rebuildPlanFromCache() is triggered by the settings listener, no need to call it twice
      if (this.capacityDryRun) {
        this.previewDeviceTargetsForMode(chosen);
      } else {
        await this.applyDeviceTargetsForMode(chosen);
      }
      return true;
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Homey Flow API has no TypeScript definitions
    if (typeof (setCapacityMode as any).registerArgumentAutocompleteListener === 'function') {
      setCapacityMode.registerArgumentAutocompleteListener('mode', async (query: string) => {
        const q = (query || '').toLowerCase();
        return Array.from(this.getAllModes())
          .filter((m) => !q || m.toLowerCase().includes(q))
          .map((m) => ({ id: m, name: m }));
      });
    }

    const hasCapacityCond = this.homey.flow.getConditionCard('has_capacity_for');
    // eslint-disable-next-line camelcase -- Homey Flow card argument names use snake_case
    hasCapacityCond.registerRunListener(async (args: { required_kw: number }) => {
      if (!this.capacityGuard) return false;
      return this.capacityGuard.hasCapacity(Number(args.required_kw));
    });

    const headroomBandCond = this.homey.flow.getConditionCard('headroom_band');
    headroomBandCond.registerRunListener(async (args: { band: string }) => {
      if (!this.capacityGuard) return false;
      return this.capacityGuard.headroomBand() === args.band;
    });

    const isCapacityModeCond = this.homey.flow.getConditionCard('is_capacity_mode');
    isCapacityModeCond.registerRunListener(async (args: { mode: string | { id: string; name: string } }) => {
      // Handle both string (manual input) and object (autocomplete selection) formats
      const modeValue = typeof args.mode === 'object' && args.mode !== null ? args.mode.id : args.mode;
      const chosenMode = (modeValue || '').trim();
      if (!chosenMode) return false;
      return this.capacityMode.toLowerCase() === chosenMode.toLowerCase();
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Homey Flow API has no TypeScript definitions
    if (typeof (isCapacityModeCond as any).registerArgumentAutocompleteListener === 'function') {
      isCapacityModeCond.registerArgumentAutocompleteListener('mode', async (query: string) => {
        const q = (query || '').toLowerCase();
        return Array.from(this.getAllModes())
          .filter((m) => !q || m.toLowerCase().includes(q))
          .map((m) => ({ id: m, name: m }));
      });
    }
  }

  private async applyDeviceTargetsForMode(mode: string): Promise<void> {
    const targets = this.modeDeviceTargets[mode];
    if (!targets || typeof targets !== 'object') {
      this.log(`No device targets configured for mode ${mode}`);
      return;
    }

    if (!this.homeyApi || !this.homeyApi.devices) {
      this.logDebug('HomeyAPI not available, cannot apply device targets');
      return;
    }

    // Use the cached snapshot to find devices with target capabilities
    for (const device of this.latestTargetSnapshot) {
      const targetValue = targets[device.id];
      if (typeof targetValue !== 'number' || Number.isNaN(targetValue)) continue;

      const targetCap = device.targets?.[0]?.id;
      if (!targetCap) continue;

      try {
        await this.homeyApi.devices.setCapabilityValue({
          deviceId: device.id,
          capabilityId: targetCap,
          value: targetValue,
        });
        this.log(`Set ${targetCap} for ${device.name} to ${targetValue} (${mode})`);
        this.updateLocalSnapshot(device.id, { target: targetValue });
      } catch (error) {
        this.error(`Failed to set ${targetCap} for ${device.name}`, error);
      }
    }

    await this.refreshTargetDevicesSnapshot();
  }

  private previewDeviceTargetsForMode(mode: string): void {
    const targets = this.modeDeviceTargets[mode];
    if (!targets || typeof targets !== 'object') {
      this.log(`Dry-run mode change: no device targets configured for mode ${mode}`);
      return;
    }

    // Use the cached snapshot to preview changes
    for (const device of this.latestTargetSnapshot) {
      const targetValue = targets[device.id];
      if (typeof targetValue !== 'number' || Number.isNaN(targetValue)) continue;

      const targetCap = device.targets?.[0]?.id;
      if (!targetCap) continue;

      this.log(`Dry-run: would set ${targetCap} for ${device.name} to ${targetValue}°C (mode ${mode})`);
    }
  }

  private startPeriodicSnapshotRefresh(): void {
    // Refresh device snapshot every 5 minutes to keep states current
    // eslint-disable-next-line homey-app/global-timers -- Cleared in onUninit
    this.snapshotRefreshInterval = setInterval(() => {
      this.refreshTargetDevicesSnapshot().catch((error: Error) => {
        this.error('Periodic snapshot refresh failed', error);
      });
    }, SNAPSHOT_REFRESH_INTERVAL_MS);
  }

  private async refreshTargetDevicesSnapshot(): Promise<void> {
    this.logDebug('Refreshing target devices snapshot');

    const snapshot = await this.fetchDevicesViaApi();

    this.homey.settings.set('target_devices_snapshot', snapshot);
    this.latestTargetSnapshot = snapshot;
    this.syncGuardFromSnapshot(snapshot);
    this.logDebug(`Stored snapshot with ${snapshot.length} devices`);
    // Note: We don't call buildDevicePlanSnapshot() here - plan building happens
    // in rebuildPlanFromCache() which is called during recordPowerSample().
    // This prevents duplicate plan builds when periodic refresh coincides with power samples.
  }

  private async refreshNettleieData(forceRefresh = false): Promise<void> {
    const fylke = this.homey.settings.get('nettleie_fylke') || '03';
    const orgnr = this.homey.settings.get('nettleie_orgnr');
    const tariffgruppe = this.homey.settings.get('nettleie_tariffgruppe') || 'Husholdning';

    if (!orgnr) {
      this.log('Nettleie: No organization number configured, skipping fetch');
      return;
    }

    const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD format

    // Check if we already have today's nettleie data (cached)
    if (!forceRefresh) {
      const existingData = this.homey.settings.get('nettleie_data') as Array<{ datoId?: string }> | null;
      if (existingData && Array.isArray(existingData) && existingData.length > 0) {
        // Check if the data is from today by looking at the first entry's datoId
        const firstEntry = existingData[0];
        if (firstEntry?.datoId?.startsWith(today)) {
          this.logDebug(`Nettleie: Using cached data for ${today} (${existingData.length} entries)`);
          // Update combined prices in case spot prices changed
          this.updateCombinedPrices();
          return;
        }
      }
    }

    const url = `https://nettleietariffer.dataplattform.nve.no/v1/NettleiePerOmradePrTimeHusholdningFritidEffekttariffer?ValgtDato=${encodeURIComponent(today)}&Tariffgruppe=${encodeURIComponent(tariffgruppe)}&FylkeNr=${encodeURIComponent(fylke)}&OrganisasjonsNr=${encodeURIComponent(orgnr)}`;

    this.log(`Nettleie: Fetching grid tariffs from NVE API for ${today}, fylke=${fylke}, org=${orgnr}`);

    try {
      const response = await fetch(url, {
        headers: {
          Accept: 'application/json',
        },
      });

      if (!response.ok) {
        throw new Error(`NVE API returned ${response.status}: ${response.statusText}`);
      }

      const data = await response.json();

      if (!Array.isArray(data)) {
        this.log('Nettleie: Unexpected response format from NVE API');
        return;
      }

      // Transform and store the data
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- NVE API response type
      const nettleieData = data.map((entry: Record<string, unknown>) => ({
        time: entry.time,
        energileddEks: entry.energileddEks,
        energileddInk: entry.energileddInk,
        fastleddEks: entry.fastleddEks,
        fastleddInk: entry.fastleddInk,
        datoId: entry.datoId,
      }));

      this.homey.settings.set('nettleie_data', nettleieData);
      this.log(`Nettleie: Stored ${nettleieData.length} hourly tariff entries`);
      this.updateCombinedPrices();
    } catch (error) {
      this.error('Nettleie: Failed to fetch grid tariffs from NVE API', error);
    }
  }

  /**
   * Update the combined_prices setting with spot + nettleie + surcharge.
   * Includes pre-calculated thresholds and cheap/expensive flags for UI consistency.
   */
  private updateCombinedPrices(): void {
    const combined = this.getCombinedHourlyPrices();
    if (combined.length === 0) {
      const emptyPrices = {
        prices: [], avgPrice: 0, lowThreshold: 0, highThreshold: 0,
      };
      this.homey.settings.set('combined_prices', emptyPrices);
      this.homey.api.realtime('prices_updated', emptyPrices).catch(() => {});
      return;
    }

    // Calculate average and thresholds (same logic used by isCurrentHourCheap/Expensive)
    const avgPrice = combined.reduce((sum, p) => sum + p.totalPrice, 0) / combined.length;
    const thresholdPercent = this.homey.settings.get('price_threshold_percent') ?? 25;
    const minDiffOre = this.homey.settings.get('price_min_diff_ore') ?? 0;
    const thresholdMultiplier = thresholdPercent / 100;
    const lowThreshold = avgPrice * (1 - thresholdMultiplier);
    const highThreshold = avgPrice * (1 + thresholdMultiplier);

    // Store prices with cheap/expensive flags
    // Also check minimum price difference from average (comfort vs savings trade-off)
    const prices = combined.map((p) => {
      const diffFromAvg = Math.abs(p.totalPrice - avgPrice);
      const meetsMinDiff = diffFromAvg >= minDiffOre;
      return {
        startsAt: p.startsAt,
        total: p.totalPrice,
        spotPrice: p.spotPrice,
        nettleie: p.nettleie,
        isCheap: p.totalPrice <= lowThreshold && meetsMinDiff,
        isExpensive: p.totalPrice >= highThreshold && meetsMinDiff,
      };
    });

    const combinedPrices = {
      prices,
      avgPrice,
      lowThreshold,
      highThreshold,
      thresholdPercent,
      minDiffOre,
    };
    this.homey.settings.set('combined_prices', combinedPrices);
    // Emit realtime event so settings page can update
    this.homey.api.realtime('prices_updated', combinedPrices).catch(() => {});
  }

  private async refreshSpotPrices(forceRefresh = false): Promise<void> {
    const priceArea = this.homey.settings.get('price_area') || 'NO1';
    const today = new Date();
    const todayStr = today.toISOString().split('T')[0];
    const tomorrowStr = new Date(today.getTime() + 24 * 60 * 60 * 1000).toISOString().split('T')[0];

    // Check if we already have today's prices (cached)
    if (!forceRefresh) {
      const existingPrices = this.homey.settings.get('electricity_prices') as Array<{ startsAt?: string }> | null;
      if (existingPrices && Array.isArray(existingPrices) && existingPrices.length > 0) {
        // Check if we have prices for today
        const hasTodayPrices = existingPrices.some((p) => p.startsAt?.startsWith(todayStr));
        const hasTomorrowPrices = existingPrices.some((p) => p.startsAt?.startsWith(tomorrowStr));

        // Tomorrow's prices are typically available after 13:00 CET
        // Refresh if it's after 13:15 and we don't have tomorrow's prices yet
        const currentHour = today.getHours();
        const currentMinute = today.getMinutes();
        const isAfter1315 = currentHour > 13 || (currentHour === 13 && currentMinute >= 15);
        const shouldFetchTomorrow = isAfter1315 && !hasTomorrowPrices;

        if (hasTodayPrices && !shouldFetchTomorrow) {
          this.logDebug(`Spot prices: Using cached data (${existingPrices.length} entries including today)`);
          // Still update combined prices in case nettleie changed
          this.updateCombinedPrices();
          return;
        }

        if (shouldFetchTomorrow) {
          this.logDebug('Spot prices: Refreshing to fetch tomorrow\'s prices (after 13:15)');
        }
      }
    }

    // Fetch today's prices
    const todayPrices = await this.fetchSpotPricesForDate(today, priceArea);

    // Try to fetch tomorrow's prices (available after 13:00)
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);
    const tomorrowPrices = await this.fetchSpotPricesForDate(tomorrow, priceArea);

    // Combine prices
    const allPrices = [...todayPrices, ...tomorrowPrices];

    if (allPrices.length > 0) {
      this.homey.settings.set('electricity_prices', allPrices);
      this.log(`Spot prices: Stored ${allPrices.length} hourly prices for ${priceArea}`);
      this.updateCombinedPrices();
    } else {
      this.log('Spot prices: No price data available');
    }
  }

  private async fetchSpotPricesForDate(date: Date, priceArea: string): Promise<Array<{ startsAt: string; total: number; currency: string }>> {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');

    const url = `https://www.hvakosterstrommen.no/api/v1/prices/${year}/${month}-${day}_${priceArea}.json`;

    this.logDebug(`Spot prices: Fetching from ${url}`);

    try {
      const data = await this.httpsGetJson(url);

      if (!Array.isArray(data)) {
        this.log('Spot prices: Unexpected response format');
        return [];
      }

      // Transform to our format
      // Note: prices from hvakosterstrommen.no are without VAT
      // We add 25% VAT for all areas except NO4 (Nord-Norge)
      const vatMultiplier = priceArea === 'NO4' ? 1.0 : 1.25;

      return data.map((entry: Record<string, unknown>) => ({
        startsAt: entry.time_start as string,
        // Convert from NOK/kWh to øre/kWh and add VAT
        total: (entry.NOK_per_kWh as number) * 100 * vatMultiplier,
        currency: 'NOK',
      }));
    } catch (error: unknown) {
      if ((error as { statusCode?: number })?.statusCode === 404) {
        // Prices not yet available (e.g., tomorrow's prices before 13:00)
        this.logDebug(`Spot prices: No data for ${year}-${month}-${day} (not yet available)`);
        return [];
      }
      this.error(`Spot prices: Failed to fetch prices for ${year}-${month}-${day}`, error);
      return [];
    }
  }

  /**
   * Make an HTTPS GET request and parse JSON response.
   * Note: rejectUnauthorized is disabled because Homey's Node.js environment
   * lacks the full certificate chain for some external APIs (e.g., hvakosterstrommen.no).
   * This is a known limitation of the Homey platform.
   */
  private httpsGetJson(url: string): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const req = https.get(
        url,
        {
          headers: { Accept: 'application/json' },
          rejectUnauthorized: false, // Required for Homey - missing CA certificates
        },
        (res) => {
          if (res.statusCode === 404) {
            const err = new Error('Not found') as Error & { statusCode: number };
            err.statusCode = 404;
            reject(err);
            return;
          }
          if (res.statusCode !== 200) {
            reject(new Error(`HTTP ${res.statusCode}: ${res.statusMessage}`));
            return;
          }

          let data = '';
          res.on('data', (chunk) => {
            data += chunk;
          });
          res.on('end', () => {
            try {
              resolve(JSON.parse(data));
            } catch (e) {
              reject(new Error('Failed to parse JSON response'));
            }
          });
        },
      );

      req.on('error', (err) => {
        reject(err);
      });

      req.setTimeout(10000, () => {
        req.destroy();
        reject(new Error('Request timeout'));
      });
    });
  }

  /**
   * Get combined hourly prices (spot + nettleie + provider surcharge) for all available hours.
   * Returns an array sorted by time, with total price in øre/kWh including VAT.
   */
  private getCombinedHourlyPrices(): Array<{ startsAt: string; spotPrice: number; nettleie: number; providerSurcharge: number; totalPrice: number }> {
    const spotPrices: Array<{ startsAt: string; total: number }> = this.homey.settings.get('electricity_prices') || [];
    const nettleieData: Array<{ time: string; energileddInk: number }> = this.homey.settings.get('nettleie_data') || [];
    const providerSurcharge: number = this.homey.settings.get('provider_surcharge') || 0;

    // Create a map of nettleie by hour (0-23)
    const nettleieByHour = new Map<number, number>();
    for (const entry of nettleieData) {
      // NVE API returns time as hour number (0-23)
      const hour = typeof entry.time === 'number' ? entry.time : parseInt(entry.time, 10);
      if (!Number.isNaN(hour) && typeof entry.energileddInk === 'number') {
        nettleieByHour.set(hour, entry.energileddInk);
      }
    }

    // Combine spot prices with nettleie and provider surcharge
    return spotPrices.map((spot) => {
      const date = new Date(spot.startsAt);
      const hour = date.getHours();
      const nettleie = nettleieByHour.get(hour) || 0;
      return {
        startsAt: spot.startsAt,
        spotPrice: spot.total,
        nettleie,
        providerSurcharge,
        totalPrice: spot.total + nettleie + providerSurcharge,
      };
    }).sort((a, b) => new Date(a.startsAt).getTime() - new Date(b.startsAt).getTime());
  }

  /**
   * Find the cheapest N hours from now within the next 24 hours.
   * Returns the start times of the cheapest hours.
   */
  private findCheapestHours(count: number): string[] {
    const now = new Date();
    const in24Hours = new Date(now.getTime() + 24 * 60 * 60 * 1000);

    const prices = this.getCombinedHourlyPrices()
      .filter((p) => {
        const time = new Date(p.startsAt);
        return time >= now && time < in24Hours;
      });

    if (prices.length === 0) return [];

    // Sort by total price and take the cheapest N
    return prices
      .sort((a, b) => a.totalPrice - b.totalPrice)
      .slice(0, count)
      .map((p) => p.startsAt);
  }

  /**
   * Check if the current hour is cheap (25% below average).
   */
  private isCurrentHourCheap(): boolean {
    const prices = this.getCombinedHourlyPrices();
    if (prices.length === 0) return false;

    const now = new Date();
    const currentHourStart = new Date(now);
    currentHourStart.setMinutes(0, 0, 0);

    const currentPrice = prices.find((p) => {
      const hourStart = new Date(p.startsAt);
      return hourStart.getTime() === currentHourStart.getTime();
    });

    if (!currentPrice) return false;

    const avgPrice = prices.reduce((sum, p) => sum + p.totalPrice, 0) / prices.length;
    const thresholdPercent = this.homey.settings.get('price_threshold_percent') ?? 25;
    const minDiffOre = this.homey.settings.get('price_min_diff_ore') ?? 0;
    const threshold = avgPrice * (1 - thresholdPercent / 100);
    const diffFromAvg = avgPrice - currentPrice.totalPrice;
    return currentPrice.totalPrice <= threshold && diffFromAvg >= minDiffOre;
  }

  /**
   * Check if the current hour is expensive (25% above average).
   */
  private isCurrentHourExpensive(): boolean {
    const prices = this.getCombinedHourlyPrices();
    if (prices.length === 0) return false;

    const now = new Date();
    const currentHourStart = new Date(now);
    currentHourStart.setMinutes(0, 0, 0);

    const currentPrice = prices.find((p) => {
      const hourStart = new Date(p.startsAt);
      return hourStart.getTime() === currentHourStart.getTime();
    });

    if (!currentPrice) return false;

    const avgPrice = prices.reduce((sum, p) => sum + p.totalPrice, 0) / prices.length;
    const thresholdPercent = this.homey.settings.get('price_threshold_percent') ?? 25;
    const minDiffOre = this.homey.settings.get('price_min_diff_ore') ?? 0;
    const threshold = avgPrice * (1 + thresholdPercent / 100);
    const diffFromAvg = currentPrice.totalPrice - avgPrice;
    return currentPrice.totalPrice >= threshold && diffFromAvg >= minDiffOre;
  }

  /**
   * Apply price optimization to all configured devices.
   * Called periodically (at start of each hour) to adjust temperatures.
   * Uses delta values relative to the mode's target temperature.
   */
  private async applyPriceOptimization(): Promise<void> {
    if (!this.homeyApi || !this.homeyApi.devices) {
      this.log('Price optimization: HomeyAPI not available, skipping');
      return;
    }

    const settings = this.priceOptimizationSettings;
    if (!settings || Object.keys(settings).length === 0) {
      this.log('Price optimization: No devices configured');
      return;
    }

    const isCheap = this.isCurrentHourCheap();
    const isExpensive = this.isCurrentHourExpensive();

    // Debug: log current price info
    const prices = this.getCombinedHourlyPrices();
    const now = new Date();
    const currentHourStart = new Date(now);
    currentHourStart.setMinutes(0, 0, 0);
    const currentPrice = prices.find((p) => new Date(p.startsAt).getTime() === currentHourStart.getTime());
    const avgPrice = prices.length > 0 ? prices.reduce((sum, p) => sum + p.totalPrice, 0) / prices.length : 0;
    const thresholdPercent = this.homey.settings.get('price_threshold_percent') ?? 25;
    const minDiffOre = this.homey.settings.get('price_min_diff_ore') ?? 0;
    this.log(`Price optimization: current=${currentPrice?.totalPrice?.toFixed(1) ?? 'N/A'} øre, avg=${avgPrice.toFixed(1)} øre, threshold=${thresholdPercent}%, minDiff=${minDiffOre} øre, isCheap=${isCheap}, isExpensive=${isExpensive}, devices=${Object.keys(settings).length}`);

    // If price is normal (not cheap or expensive), use the mode's base temperature
    // eslint-disable-next-line no-nested-ternary -- Clear price state mapping
    const priceState = isCheap ? 'cheap' : isExpensive ? 'expensive' : 'normal';

    for (const [deviceId, config] of Object.entries(settings)) {
      if (!config.enabled) continue;

      // Find the device in snapshot to get its current capability
      const device = this.latestTargetSnapshot.find((d) => d.id === deviceId);
      if (!device || !device.targets || device.targets.length === 0) {
        this.logDebug(`Price optimization: Device ${deviceId} not found or has no target capability`);
        continue;
      }

      // Get the mode's base target temperature for this device
      const modeTargets = this.homey.settings.get('mode_device_targets') || {};
      const currentMode = this.homey.settings.get('capacity_mode') || 'Home';
      const baseTemp = modeTargets[currentMode]?.[deviceId];

      if (baseTemp === undefined) {
        this.logDebug(`Price optimization: No mode target for ${device.name} in mode ${currentMode}`);
        continue;
      }

      // Calculate the target temperature based on price state
      let targetTemp = baseTemp;
      if (isCheap && config.cheapDelta) {
        targetTemp = baseTemp + config.cheapDelta;
      } else if (isExpensive && config.expensiveDelta) {
        targetTemp = baseTemp + config.expensiveDelta;
      }

      const targetCap = device.targets[0].id;
      const currentTarget = device.targets[0].value;

      // Only update if different
      if (currentTarget === targetTemp) {
        this.logDebug(`Price optimization: ${device.name} already at ${targetTemp}°C`);
        continue;
      }

      try {
        await this.homeyApi.devices.setCapabilityValue({
          deviceId,
          capabilityId: targetCap,
          value: targetTemp,
        });
        const priceInfo = this.getCurrentHourPriceInfo();
        // eslint-disable-next-line no-nested-ternary -- Clear delta info mapping
        const deltaInfo = isCheap ? `+${config.cheapDelta}` : isExpensive ? `${config.expensiveDelta}` : '0';
        this.log(`Price optimization: Set ${device.name} to ${targetTemp}°C (${priceState} hour, delta ${deltaInfo}, base ${baseTemp}°C, ${priceInfo})`);
        this.updateLocalSnapshot(deviceId, { target: targetTemp });
      } catch (error) {
        this.error(`Price optimization: Failed to set ${device.name} to ${targetTemp}°C`, error);
      }
    }
  }

  /**
   * Get a human-readable price info for the current hour.
   */
  private getCurrentHourPriceInfo(): string {
    const prices = this.getCombinedHourlyPrices();
    const now = new Date();
    const currentHourStart = new Date(now);
    currentHourStart.setMinutes(0, 0, 0);

    const current = prices.find((p) => {
      const hourStart = new Date(p.startsAt);
      return hourStart.getTime() === currentHourStart.getTime();
    });

    if (!current) return 'price unknown';
    return `${current.totalPrice.toFixed(1)} øre/kWh (spot ${current.spotPrice.toFixed(1)} + nettleie ${current.nettleie.toFixed(1)})`;
  }

  /**
   * Start periodic price optimization checks.
   * Runs at the start of each hour.
   */
  private async startPriceOptimization(): Promise<void> {
    // Calculate ms until the next hour
    const now = new Date();
    const nextHour = new Date(now);
    nextHour.setHours(nextHour.getHours() + 1, 0, 0, 0);
    const msUntilNextHour = nextHour.getTime() - now.getTime();

    // Run once now (await to ensure initial price optimization is applied before onInit completes)
    await this.applyPriceOptimization();

    // Schedule to run at the start of each hour
    setTimeout(() => {
      this.applyPriceOptimization().catch((error: Error) => {
        this.error('Price optimization failed', error);
      });

      // Then run every hour
      // eslint-disable-next-line homey-app/global-timers -- Cleared in onUninit
      this.priceOptimizationInterval = setInterval(() => {
        this.applyPriceOptimization().catch((error: Error) => {
          this.error('Price optimization failed', error);
        });
      }, 60 * 60 * 1000);
    }, msUntilNextHour);
  }

  /**
   * Start periodic price data refresh.
   * Refreshes spot prices and nettleie data periodically.
   * Note: Initial fetch is done in onInit before this is called.
   */
  private startPriceRefresh(): void {
    // Refresh prices every 3 hours
    const refreshIntervalMs = 3 * 60 * 60 * 1000;

    // eslint-disable-next-line homey-app/global-timers -- Cleared in onUninit
    this.priceRefreshInterval = setInterval(() => {
      this.refreshSpotPrices().catch((error: Error) => {
        this.error('Failed to refresh spot prices', error);
      });
      this.refreshNettleieData().catch((error: Error) => {
        this.error('Failed to refresh nettleie data', error);
      });
    }, refreshIntervalMs);
  }

  private async fetchDevicesViaApi(): Promise<Array<{ id: string; name: string; targets: Array<{ id: string; value: unknown; unit: string }>; powerKw?: number }>> {
    // Prefer the HomeyAPI helper if available.
    if (this.homeyApi) {
      try {
        const devicesObj = await this.homeyApi.devices.getDevices();
        const list = Object.values(devicesObj || {});
        this.logDebug(`HomeyAPI returned ${list.length} devices`);
        return this.parseDeviceList(list);
      } catch (error) {
        this.logDebug('HomeyAPI.getDevices failed, falling back to raw API', error as Error);
      }
    }

    let devices;
    try {
      devices = await this.homey.api.get('manager/devices');
    } catch (error) {
      this.logDebug('Manager API manager/devices failed, retrying devices', error as Error);
      try {
        devices = await this.homey.api.get('devices');
      } catch (err) {
        this.logDebug('Manager API devices failed as well', err as Error);
        return [];
      }
    }
    const list = Array.isArray(devices) ? devices : Object.values(devices || {});

    this.logDebug(`Manager API returned ${list.length} devices`);

    return this.parseDeviceList(list);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any, max-len -- Homey device objects have no TypeScript definitions
  private parseDeviceList(list: any[]): Array<{ id: string; name: string; targets: Array<{ id: string; value: unknown; unit: string }>; powerKw?: number; priority?: number; currentOn?: boolean; zone?: string; controllable?: boolean; currentTemperature?: number }> {
    return list
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Homey device objects have no TypeScript definitions
      .map((device: any) => {
        const capabilities: string[] = device.capabilities || [];
        const capabilityObj = device.capabilitiesObj || {};
        const currentTemperature = typeof capabilityObj.measure_temperature?.value === 'number' ? capabilityObj.measure_temperature.value : undefined;
        const powerRaw = capabilityObj.measure_power?.value;
        const deviceId = device.id || device.data?.id || device.name;
        const isOn = capabilityObj.onoff?.value === true;
        let powerKw: number | undefined;

        // Priority for power estimates:
        // 1. measure_power (real-time, when device is actively drawing)
        // 2. settings.load (configured expected load)
        // 3. lastKnownPowerKw (last observed power when device was on)
        if (typeof powerRaw === 'number' && powerRaw > 0) {
          powerKw = powerRaw > MIN_SIGNIFICANT_POWER_W ? powerRaw / 1000 : powerRaw;
          // Track this as the last known power for this device (when on and drawing)
          if (isOn && powerKw > MIN_SIGNIFICANT_POWER_W / 1000) {
            this.lastKnownPowerKw[deviceId] = powerKw;
          }
        } else if (device.settings && typeof device.settings.load === 'number') {
          const loadW = device.settings.load;
          powerKw = loadW > MIN_SIGNIFICANT_POWER_W ? loadW / 1000 : loadW;
        } else if (this.lastKnownPowerKw[deviceId]) {
          // Use last known power as fallback
          powerKw = this.lastKnownPowerKw[deviceId];
        }

        const targetCaps = capabilities.filter((cap) => TARGET_CAPABILITY_PREFIXES.some((prefix) => cap.startsWith(prefix)));
        if (targetCaps.length === 0) {
          return null;
        }

        const targets = targetCaps.map((capId) => ({
          id: capId,
          value: capabilityObj[capId]?.value ?? null,
          unit: capabilityObj[capId]?.units || '°C',
        }));

        // Determine if device is ON:
        // 1. Check explicit onoff capability
        // 2. Fall back to checking if device is drawing significant power (>50W)
        let currentOn: boolean | undefined;
        if (typeof capabilityObj.onoff?.value === 'boolean') {
          currentOn = capabilityObj.onoff.value;
        } else if (typeof powerRaw === 'number' && powerRaw > 50) {
          // Device is drawing power, consider it ON even without onoff capability
          currentOn = true;
        }

        return {
          id: deviceId,
          name: device.name,
          targets,
          powerKw,
          priority: this.getPriorityForDevice(deviceId),
          currentOn,
          currentTemperature,
          // Prefer modern zone structure; fall back to legacy to avoid deprecation warning.
          zone: device.zone?.name
            || (typeof device.zone === 'string' ? device.zone : undefined)
            || device.zoneName
            || 'Unknown',
          controllable: this.controllableDevices[deviceId] ?? true,
        };
      })
      .filter(Boolean) as Array<{
        id: string;
        name: string;
        targets: Array<{ id: string; value: unknown; unit: string }>;
        powerKw?: number;
        priority?: number;
        currentOn?: boolean;
        zone?: string;
        controllable?: boolean;
        currentTemperature?: number;
      }>;
  }

  private rebuildPlanFromCache(): void {
    if (!this.latestTargetSnapshot || this.latestTargetSnapshot.length === 0) return;
    const plan = this.buildDevicePlanSnapshot(this.latestTargetSnapshot);
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
          const desiredPower = d.plannedState === 'shed' ? 'off' : 'on';
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
            const nextPower = d.plannedState === 'shed' ? 'off' : 'on';
            const power = `${d.currentState} -> ${nextPower}`;
            const powerInfo = typeof d.powerKw === 'number'
              ? `, est ${d.powerKw.toFixed(2)}kW`
              : '';
            const headroomInfo = typeof headroom === 'number'
              ? `, headroom ${headroom.toFixed(2)}kW`
              : '';
            const restoringHint = d.currentState === 'off' && nextPower === 'on'
              ? ` (restoring, needs ~${(typeof d.powerKw === 'number' ? d.powerKw : 1).toFixed(2)}kW${
                typeof headroom === 'number' ? ` vs headroom ${headroom.toFixed(2)}kW` : ''
              })`
              : '';
            return `${d.name}: temp ${temp}, power ${power}${powerInfo}${headroomInfo}, reason: ${
              d.reason ?? 'n/a'
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
    this.homey.api.realtime('plan_updated', plan).catch(() => {});
    const hasShedding = plan.devices.some((d) => d.plannedState === 'shed');
    if (this.capacityDryRun && hasShedding) {
      this.logDebug('Dry run enabled; skipping shedding actions.');
    }
    if (!this.capacityDryRun) {
      this.applyPlanActions(plan).catch((error: Error) => this.error('Failed to apply plan actions', error));
    }
  }

  private buildDevicePlanSnapshot(devices: Array<{ id: string; name: string; targets: Array<{ id: string; value: unknown; unit: string }>; powerKw?: number; priority?: number; currentOn?: boolean; zone?: string; controllable?: boolean; currentTemperature?: number }>): {
    meta: { totalKw: number | null; softLimitKw: number; headroomKw: number | null; hourlyBudgetExhausted?: boolean; usedKWh?: number; budgetKWh?: number };
    devices: Array<{
      id: string;
      name: string;
      currentState: string;
      plannedState: string;
      currentTarget: unknown;
      plannedTarget: number | null;
      priority?: number;
      powerKw?: number;
      reason?: string;
      zone?: string;
      controllable?: boolean;
      currentTemperature?: number;
    }>;
  } {
    const desiredForMode = this.modeDeviceTargets[this.capacityMode] || {};
    const total = this.capacityGuard ? this.capacityGuard.getLastTotalPower() : null;
    const softLimit = this.computeDynamicSoftLimit();

    // Compute used/budget kWh for this hour
    const budgetKWh = Math.max(0, this.capacitySettings.limitKw - this.capacitySettings.marginKw);
    const now = Date.now();
    const hourStart = new Date(now);
    hourStart.setMinutes(0, 0, 0);
    const bucketKey = hourStart.toISOString();
    const usedKWh = this.powerTracker.buckets?.[bucketKey] || 0;

    const headroomRaw = total === null ? null : softLimit - total;
    let headroom = headroomRaw === null && softLimit <= 0 ? -1 : headroomRaw;
    // Hysteresis: require some positive margin before we start turning things back on.
    const restoreMargin = Math.max(0.1, this.capacitySettings.marginKw || 0);
    if (headroom !== null && headroom < restoreMargin) {
      // Treat as deficit until we have at least restoreMargin of headroom.
      headroom -= restoreMargin;
    }
    // If the hourly energy budget is exhausted and soft limit is zero while instantaneous power reads ~0,
    // force a minimal negative headroom to proactively shed controllable devices.
    if (this.hourlyBudgetExhausted && softLimit <= 0 && total !== null && total <= 0.01) {
      headroom = -1; // triggers shedding logic with needed ~=1 kW (effectivePower fallback)
    }

    const sheddingActive = this.capacityGuard ? this.capacityGuard.isSheddingActive() : false;
    const shedSet = new Set<string>();
    const shedReasons = new Map<string, string>();
    const restoreMarginPlanning = Math.max(0.1, this.capacitySettings.marginKw || 0);
    if (headroom !== null && headroom < 0) {
      this.lastOvershootMs = Date.now();
      const needed = -headroom;
      this.logDebug(
        `Planning shed: soft=${softLimit.toFixed(3)} headroom=${headroom.toFixed(
          3,
        )} total=${total === null ? 'unknown' : total.toFixed(3)}`,
      );
      const candidates = devices
        .filter((d) => d.controllable !== false && d.currentOn !== false)
        .map((d) => {
          const priority = this.getPriorityForDevice(d.id);
          const power = typeof d.powerKw === 'number' && d.powerKw > 0 ? d.powerKw : 1; // fallback when unknown
          // eslint-disable-next-line node/no-unsupported-features/es-syntax -- App targets Node 18+
          return { ...d, priority, effectivePower: power };
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
        if (remaining <= 0) break;
        shedSet.add(c.id);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Extended device object with effectivePower
        shedReasons.set(c.id, `shed due to capacity (priority ${c.priority ?? 100}, est ${((c as any).effectivePower as number).toFixed(2)}kW)`);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Extended device object with effectivePower
        remaining -= (c as any).effectivePower as number;
      }

      // Only raise a shortfall when we truly cannot shed enough controllable load to reach the soft limit.
      // Add a small tolerance to avoid noisy triggers when we are only a few watts over.
      const shortfallTolerance = 0.05;
      if (remaining > shortfallTolerance && totalSheddable < needed - shortfallTolerance) {
        // Even after shedding all controllable ON devices we are still over budget.
        const deficitKw = remaining;
        this.log(`Capacity shortfall: cannot reach soft limit, deficit ~${deficitKw.toFixed(2)}kW (total ${
          total === null ? 'unknown' : total.toFixed(2)
        }kW, soft ${softLimit.toFixed(2)}kW)`);
        const card = this.homey.flow?.getTriggerCard?.('capacity_shortfall');
        if (card && typeof card.trigger === 'function') {
          const result = card.trigger({});
          // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-misused-promises -- Homey trigger returns a possibly-thenable
          if (result && typeof (result as any).catch === 'function') {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Homey trigger returns a possibly-thenable
            (result as any).catch((err: Error) => this.error('Failed to trigger capacity_shortfall', err));
          }
        }
      }
    }

    const planDevices = devices.map((dev) => {
      const priority = this.getPriorityForDevice(dev.id);
      const desired = desiredForMode[dev.id];
      let plannedTarget = Number.isFinite(desired) ? Number(desired) : null;

      // Apply price optimization delta if configured for this device
      const priceOptConfig = this.priceOptimizationSettings[dev.id];
      if (plannedTarget !== null && priceOptConfig?.enabled) {
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
      // eslint-disable-next-line no-nested-ternary -- Clear controllable-to-state mapping
      let plannedState = controllable ? (shedSet.has(dev.id) ? 'shed' : 'keep') : 'keep';
      let reason = controllable ? shedReasons.get(dev.id) || `keep (priority ${priority})` : 'not controllable by PELS';
      if (controllable && plannedState !== 'shed' && currentState === 'off') {
        const need = (dev.powerKw && dev.powerKw > 0 ? dev.powerKw : 1) + restoreMarginPlanning;
        const hr = headroomRaw;
        reason = `restore (need ${need.toFixed(2)}kW, headroom ${hr === null ? 'unknown' : hr.toFixed(2)}kW)`;
      }

      // If hourly energy budget exhausted, proactively shed any controllable device that is currently on (or unknown state)
      if (this.hourlyBudgetExhausted && controllable && plannedState !== 'shed' && (currentState === 'on' || currentState === 'unknown')) {
        plannedState = 'shed';
        reason = 'shed due to exhausted hourly energy budget';
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
        reason,
        zone: dev.zone || 'Unknown',
        controllable,
        currentTemperature: dev.currentTemperature,
      };
    });

    // Secondary guard: if a device is currently off and headroom is still below what it needs plus margin,
    // keep it shed to avoid on/off flapping.
    // Also limit cumulative restore to 50% of available headroom to prevent oscillation.
    // Also respect cooldown period after shedding to avoid rapid on/off cycles.
    // Also wait after restoring a device to let the power measurement stabilize before restoring more.
    const sinceShedding = this.lastSheddingMs ? Date.now() - this.lastSheddingMs : null;
    const sinceOvershoot = this.lastOvershootMs ? Date.now() - this.lastOvershootMs : null;
    const sinceRestore = this.lastRestoreMs ? Date.now() - this.lastRestoreMs : null;
    const inCooldown = (sinceShedding !== null && sinceShedding < SHED_COOLDOWN_MS) || (sinceOvershoot !== null && sinceOvershoot < SHED_COOLDOWN_MS);
    const inRestoreCooldown = sinceRestore !== null && sinceRestore < RESTORE_COOLDOWN_MS;

    // Clean up stale swap tracking - if a swap couldn't complete within timeout, release the blocked devices
    const swapCleanupNow = Date.now();
    for (const swapTargetId of [...this.pendingSwapTargets]) {
      const swapTime = this.pendingSwapTimestamps[swapTargetId];
      if (swapTime && swapCleanupNow - swapTime > SWAP_TIMEOUT_MS) {
        this.log(`Plan: clearing stale swap for ${swapTargetId} (${Math.round((swapCleanupNow - swapTime) / 1000)}s since swap initiated)`);
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

    if (headroomRaw !== null && !sheddingActive && !inCooldown && !inRestoreCooldown) {
      let availableHeadroom = headroomRaw;
      const restoredThisCycle = new Set<string>(); // Track devices restored in this planning cycle

      // Sort off devices by priority (priority 1 = most important, restore first)
      const offDevices = planDevices
        .filter((d) => d.controllable !== false && d.currentState === 'off' && d.plannedState !== 'shed')
        .sort((a, b) => (a.priority ?? 999) - (b.priority ?? 999)); // Lower number = higher importance

      // Get ON devices sorted by priority (higher number = less important, shed first for swaps)
      const onDevices = planDevices
        .filter((d) => d.controllable !== false && d.currentState === 'on' && d.plannedState !== 'shed')
        .sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0)); // Higher number = shed first

      // Restore safety buffer: require headroom to stay positive by this much AFTER restore
      // This prevents oscillation from measurement variance/latency
      const restoreHysteresis = Math.max(0.2, restoreMarginPlanning * 2);

      // Only restore ONE device per cycle, then wait for new measurements.
      // This avoids relying on potentially inaccurate power estimates (settings.load, etc.)
      // and lets us observe the actual impact before restoring more.
      let restoredOneThisCycle = false;

      for (const dev of offDevices) {
        // Skip if we already restored one device this cycle
        if (restoredOneThisCycle) {
          dev.plannedState = 'shed';
          dev.reason = 'stay off (waiting for measurement after previous restore)';
          continue;
        }

        // Check if this device was swapped out for a higher-priority device
        // Don't restore it until that higher-priority device is restored first
        const swappedFor = this.swappedOutFor[dev.id];
        if (swappedFor) {
          const higherPriDev = planDevices.find((d) => d.id === swappedFor);
          // If the higher-priority device is still off, don't restore this one
          if (higherPriDev && higherPriDev.currentState === 'off') {
            dev.plannedState = 'shed';
            dev.reason = `stay off (swapped out for ${higherPriDev.name}, waiting for it to restore first)`;
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
            dev.reason = `stay off (pending swap target ${blockedBySwapTarget.name} p${blockedBySwapTarget.priority} should restore first)`;
            this.logDebug(`Plan: blocking restore of ${dev.name} (p${devPriority}) - swap target ${blockedBySwapTarget.name} (p${blockedBySwapTarget.priority}) should restore first`);
            continue;
          }
        }

        const devPower = dev.powerKw && dev.powerKw > 0 ? dev.powerKw : 1;
        // Need enough headroom to restore AND keep a safety buffer afterward
        const needed = devPower + restoreHysteresis;

        if (availableHeadroom >= needed) {
          // Enough headroom - restore this device
          availableHeadroom -= devPower + restoreHysteresis; // Reserve the hysteresis buffer
          restoredThisCycle.add(dev.id);
          restoredOneThisCycle = true; // Only restore one device per cycle
        } else {
          // Not enough headroom or budget - try to swap with lower priority ON devices
          const devPriority = dev.priority ?? 100;
          let potentialHeadroom = availableHeadroom;
          const toShed: typeof onDevices = [];

          for (const onDev of onDevices) {
            // Don't shed equal or higher priority devices (lower number = higher priority)
            if ((onDev.priority ?? 100) <= devPriority) break;
            if (onDev.plannedState === 'shed') continue; // Already being shed
            if (restoredThisCycle.has(onDev.id)) continue; // Don't swap out something we just decided to restore

            const onDevPower = onDev.powerKw && onDev.powerKw > 0 ? onDev.powerKw : 1;
            toShed.push(onDev);
            potentialHeadroom += onDevPower;

            if (potentialHeadroom >= needed) break; // Enough room now
          }

          if (potentialHeadroom >= needed && toShed.length > 0) {
            // Swap: shed the low-priority devices and restore the high-priority one
            // Swaps are budget-neutral (shedding creates headroom), so don't count against restore budget
            this.log(`Plan: swap approved for ${dev.name} - shedding ${toShed.map((d) => d.name).join(', ')} (${toShed.reduce((sum, d) => sum + (d.powerKw ?? 1), 0).toFixed(2)}kW) to get ${potentialHeadroom.toFixed(2)}kW >= ${needed.toFixed(2)}kW needed`);
            // Track this device as a pending swap target - no lower-priority device should restore first
            this.pendingSwapTargets.add(dev.id);
            this.pendingSwapTimestamps[dev.id] = Date.now();
            for (const shedDev of toShed) {
              shedDev.plannedState = 'shed';
              shedDev.reason = `swapped out for higher priority ${dev.name} (p${devPriority})`;
              this.log(`Plan: swapping out ${shedDev.name} (p${shedDev.priority ?? 100}, ~${(shedDev.powerKw ?? 1).toFixed(2)}kW) to restore ${dev.name} (p${devPriority})`);
              availableHeadroom += shedDev.powerKw && shedDev.powerKw > 0 ? shedDev.powerKw : 1;
              // Track that this device was swapped out for the higher-priority device
              // It should not be restored until the higher-priority device is restored first
              this.swappedOutFor[shedDev.id] = dev.id;
            }
            availableHeadroom -= devPower + restoreHysteresis; // Reserve the hysteresis buffer for swaps too
            restoredThisCycle.add(dev.id);
            restoredOneThisCycle = true; // Swap counts as a restore - wait for measurement
            // Note: we don't add to cumulativeRestorePower for swaps since it's net-neutral
          } else {
            // Cannot restore - not enough headroom even with swaps
            dev.plannedState = 'shed';
            dev.reason = `stay off (insufficient headroom ${availableHeadroom.toFixed(2)}kW < ${needed.toFixed(2)}kW needed, no lower-priority devices to swap)`;
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
        // eslint-disable-next-line no-nested-ternary -- Clear state-dependent reason selection
        dev.reason = sheddingActive
          ? 'stay off while shedding is active'
          : inCooldown
            ? `stay off during cooldown (${Math.max(0, SHED_COOLDOWN_MS - (sinceShedding ?? sinceOvershoot ?? 0)) / 1000}s remaining)`
            : `stay off (waiting for power to stabilize after last restore, ${Math.max(0, RESTORE_COOLDOWN_MS - (sinceRestore ?? 0)) / 1000}s remaining)`;
        this.logDebug(`Plan: skipping restore of ${dev.name} (p${dev.priority ?? 100}, ~${(dev.powerKw ?? 1).toFixed(2)}kW) - ${dev.reason}`);
      }
    }

    // Sort devices by priority ascending (priority 1 = most important, shown first)
    planDevices.sort((a, b) => (a.priority ?? 999) - (b.priority ?? 999));

    return {
      meta: {
        totalKw: total,
        softLimitKw: softLimit,
        headroomKw: headroom,
        hourlyBudgetExhausted: this.hourlyBudgetExhausted,
        usedKWh,
        budgetKWh,
      },
      devices: planDevices,
    };
  }

  private syncGuardFromSnapshot(snapshot: Array<{ id: string; name: string; powerKw?: number; priority?: number; currentOn?: boolean; controllable?: boolean }>): void {
    if (!this.capacityGuard) return;
    const controllables = snapshot
      .filter((d) => d.controllable !== false)
      .map((d) => ({
        id: d.id,
        name: d.name,
        powerKw: typeof d.powerKw === 'number' && d.powerKw > 0 ? d.powerKw : 1,
        priority: this.getPriorityForDevice(d.id),
        on: d.currentOn === true,
      }));
    this.capacityGuard.setControllables(controllables);
  }

  private getPriorityForDevice(deviceId: string): number {
    const mode = this.capacityMode || 'Home';
    return this.capacityPriorities[mode]?.[deviceId] ?? 100;
  }

  private getAllModes(): Set<string> {
    const modes = new Set<string>();
    if (this.capacityMode) modes.add(this.capacityMode);
    Object.keys(this.capacityPriorities || {}).forEach((m) => {
      if (m && m.trim()) modes.add(m);
    });
    Object.keys(this.modeDeviceTargets || {}).forEach((m) => {
      if (m && m.trim()) modes.add(m);
    });
    return modes;
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
    const remainingHours = Math.max(remainingMs / 3600000, 0.01);

    const bucketKey = new Date(hourStart).toISOString();
    const usedKWh = this.powerTracker.buckets?.[bucketKey] || 0;
    const remainingKWh = Math.max(0, netBudgetKWh - usedKWh);
    this.hourlyBudgetExhausted = remainingKWh <= 0;

    // Calculate instantaneous rate needed to use remaining budget
    const burstRateKw = remainingKWh / remainingHours;

    // Cap the soft limit to the base sustainable rate (netBudgetKWh kW).
    // This prevents the "end of hour burst" problem where devices ramp up
    // to use remaining budget, then immediately overshoot the next hour.
    // By never allowing more than the sustainable rate, devices won't be
    // turned on at the end of hour N if they'd overshoot hour N+1.
    const sustainableRateKw = netBudgetKWh; // kWh/h = kW at steady state
    const allowedKw = Math.min(burstRateKw, sustainableRateKw);

    this.logDebug(
      `Soft limit calc: budget=${netBudgetKWh.toFixed(3)}kWh used=${usedKWh.toFixed(3)}kWh remaining=${remainingKWh.toFixed(3)}kWh timeLeft=${remainingHours.toFixed(3)}h burst=${burstRateKw.toFixed(3)}kW capped=${allowedKw.toFixed(3)}kW`,
    );
    return allowedKw;
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
    const name = deviceName || deviceId;
    // Mark as pending before async operation
    this.pendingSheds.add(deviceId);
    try {
      if (this.homeyApi && this.homeyApi.devices && typeof this.homeyApi.devices.setCapabilityValue === 'function') {
        try {
          await this.homeyApi.devices.setCapabilityValue({ deviceId, capabilityId: 'onoff', value: false });
          this.log(`Capacity: turned off ${name} (${reason || 'shedding'})`);
          this.updateLocalSnapshot(deviceId, { on: false });
          this.lastSheddingMs = now;
          this.lastDeviceShedMs[deviceId] = now;
          return;
        } catch (error) {
          this.error(`Failed to turn off ${name} via HomeyAPI`, error);
        }
      }

      this.logDebug(`Actuator: device ${name} not found for shedding`);
    } finally {
      this.pendingSheds.delete(deviceId);
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any, max-len -- Plan structure has dynamic target values
  private async applyPlanActions(plan: { devices: Array<{ id: string; name?: string; plannedState: string; currentState: string; plannedTarget: number | null; currentTarget: any; controllable?: boolean }> }): Promise<void> {
    if (!plan || !Array.isArray(plan.devices)) return;
    // Track cumulative restored power this cycle to limit restore rate
    let restoredPowerThisCycle = 0;
    const headroomAtStart = this.capacityGuard ? this.capacityGuard.getHeadroom() : null;
    const maxRestoreBudget = headroomAtStart !== null ? Math.max(0, headroomAtStart * 0.5) : 0;

    for (const dev of plan.devices) {
      if (dev.controllable === false) continue;
      // Apply on/off when shedding.
      if (dev.plannedState === 'shed' && dev.currentState !== 'off') {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Dev reason is dynamically added
        const { reason } = dev as any;
        const isSwap = reason && reason.includes('swapped out for');
        await this.applySheddingToDevice(dev.id, dev.name, isSwap ? reason : undefined);
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
        const restoreMargin = Math.max(0.1, this.capacitySettings.marginKw || 0);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Device power is dynamically available
        const plannedPower = (dev as any).powerKw && (dev as any).powerKw > 0 ? (dev as any).powerKw : 1;
        const extraBuffer = Math.max(0.2, restoreMargin); // add a little hysteresis for restores
        const neededForDevice = plannedPower + restoreMargin + extraBuffer;
        const sinceShedding = this.lastSheddingMs ? Date.now() - this.lastSheddingMs : null;
        const sinceOvershoot = this.lastOvershootMs ? Date.now() - this.lastOvershootMs : null;
        const inCooldown = (sinceShedding !== null && sinceShedding < SHED_COOLDOWN_MS) || (sinceOvershoot !== null && sinceOvershoot < SHED_COOLDOWN_MS);
        // Check if restoring this device would exceed our restore budget for this cycle
        const wouldExceedRestoreBudget = restoredPowerThisCycle + plannedPower > maxRestoreBudget;
        // Do not restore devices while shedding is active, during cooldown, when headroom is unknown or near zero,
        // when there is insufficient headroom for this device plus buffers, or when we've used up the restore budget.
        if (sheddingActive || inCooldown || headroom === null || headroom <= 0 || headroom < neededForDevice || wouldExceedRestoreBudget) {
          /* eslint-disable no-nested-ternary, max-len -- Clear state-dependent reason logging */
          this.logDebug(
            `Capacity: keeping ${name} off (${sheddingActive ? 'shedding active' : inCooldown ? 'cooldown' : wouldExceedRestoreBudget ? 'restore budget exceeded' : 'insufficient/unknown headroom'}, need ${neededForDevice.toFixed(
              3,
            )}kW, headroom ${headroom === null ? 'unknown' : headroom.toFixed(3)}, device ~${plannedPower.toFixed(2)}kW, cooldown ${inCooldown ? 'yes' : 'no'}, restored ${restoredPowerThisCycle.toFixed(2)}/${maxRestoreBudget.toFixed(2)}kW)`,
          );
          /* eslint-enable no-nested-ternary, max-len */
          continue;
        }
        // Mark as pending before async operation
        this.pendingRestores.add(dev.id);
        restoredPowerThisCycle += plannedPower; // Track restored power upfront to prevent concurrent restores
        try {
          if (this.homeyApi && this.homeyApi.devices && typeof this.homeyApi.devices.setCapabilityValue === 'function') {
            try {
              await this.homeyApi.devices.setCapabilityValue({ deviceId: dev.id, capabilityId: 'onoff', value: true });
              this.log(`Capacity: turning on ${name} (restored from shed/off state)`);
              this.updateLocalSnapshot(dev.id, { on: true });
              this.lastRestoreMs = Date.now(); // Track when we restored so we can wait for power to stabilize
              // Clear this device from pending swap targets if it was one
              this.pendingSwapTargets.delete(dev.id);
              delete this.pendingSwapTimestamps[dev.id];
            } catch (error) {
              this.error(`Failed to turn on ${name} via HomeyAPI`, error);
            }
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

        if (this.homeyApi && this.homeyApi.devices && typeof this.homeyApi.devices.setCapabilityValue === 'function') {
          try {
            await this.homeyApi.devices.setCapabilityValue({
              deviceId: dev.id,
              capabilityId: targetCap,
              value: dev.plannedTarget,
            });
            this.log(
              `Set ${targetCap} for ${dev.name || dev.id} ${dev.currentTarget === undefined || dev.currentTarget === null ? '' : `from ${dev.currentTarget} `}to ${dev.plannedTarget} (mode: ${this.capacityMode})`,
            );
            this.updateLocalSnapshot(dev.id, { target: dev.plannedTarget });
          } catch (error) {
            this.error(`Failed to set ${targetCap} for ${dev.name || dev.id} via HomeyAPI`, error);
          }
        }
      }
    }
  }
};
