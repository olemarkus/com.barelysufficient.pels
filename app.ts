import Homey from 'homey';

const TARGET_CAPABILITY_PREFIXES = ['target_temperature', 'thermostat_setpoint'];
const DEBUG_LOG = false;

// Timing constants for shedding/restore behavior
const SHED_COOLDOWN_MS = 12000; // Wait 12s after shedding before considering restores
const RESTORE_COOLDOWN_MS = 6000; // Wait 6s after restore for power to stabilize
const SHED_THROTTLE_MS = 5000; // Minimum time between shed attempts for same device
const SNAPSHOT_REFRESH_INTERVAL_MS = 5 * 60 * 1000; // Refresh device snapshot every 5 minutes

// Power thresholds
const MIN_SIGNIFICANT_POWER_W = 50; // Minimum power draw to consider "on" or worth tracking

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { HomeyAPI } = require('homey-api');
import CapacityGuard from './capacityGuard';

module.exports = class PelsApp extends Homey.App {
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
  // Set when remaining hourly energy budget has been fully consumed (remainingKWh <= 0)
  private hourlyBudgetExhausted = false;
  // Track last known power draw (kW) for each device when it was ON and drawing power > 0
  // Used as a fallback estimate when settings.load is not available
  private lastKnownPowerKw: Record<string, number> = {};

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
        this.loadPowerTracker();
        this.rebuildPlanFromCache();
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
      onSheddingStart: async () => {
        await this.homey.flow.getTriggerCard('capacity_shedding_started').trigger({});
      },
      onSheddingEnd: async () => {
        await this.homey.flow.getTriggerCard('capacity_shedding_ended').trigger({});
      },
      onDeviceShed: async (deviceId, deviceName) => {
        await this.homey.flow.getTriggerCard('capacity_device_shed').trigger({
          device_id: deviceId,
          device_name: deviceName,
        });
      },
      log: (...args) => this.log(...args),
      errorLog: (...args) => this.error(...args),
    });
    this.capacityGuard.setSoftLimitProvider(() => this.computeDynamicSoftLimit());
    this.capacityGuard.start();
    await this.refreshTargetDevicesSnapshot();
    await this.applyDeviceTargetsForMode(this.capacityMode);
    this.registerFlowCards();
    this.loadPowerTracker();
    this.startPeriodicSnapshotRefresh();
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
    if (this.capacityGuard) {
      this.capacityGuard.stop();
    }
  }

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

    let previousTs = state.lastTimestamp;
    let previousPower = state.lastPowerW;
    let remainingMs = nowMs - previousTs;

    while (remainingMs > 0) {
      const hourStart = this.truncateToHour(previousTs);
      const hourEnd = hourStart + 60 * 60 * 1000;
      const segmentMs = Math.min(remainingMs, hourEnd - previousTs);
      // previousPower is in W; convert to kWh for the elapsed segment.
      const energyKWh = (previousPower / 1000) * (segmentMs / 3600000);
      const bucketKey = new Date(hourStart).toISOString();
      state.buckets[bucketKey] = (state.buckets[bucketKey] || 0) + energyKWh;

      remainingMs -= segmentMs;
      previousTs += segmentMs;
    }

    state.lastTimestamp = nowMs;
    state.lastPowerW = currentPowerW;
    if (this.capacityGuard) this.capacityGuard.reportTotalPower(currentPowerW / 1000);
    this.rebuildPlanFromCache();
    this.savePowerTracker();
  }

  private async initHomeyApi(): Promise<void> {
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
    setLimitCard.registerRunListener(async (args: { limit_kw: number }) => {
      if (!this.capacityGuard) return false;
      const limit = Number(args.limit_kw);
      if (!Number.isFinite(limit) || limit <= 0) {
        throw new Error('Limit must be a positive number (kW).');
      }
      this.capacityGuard.setLimit(limit);
      return true;
    });

    const requestOnCard = this.homey.flow.getActionCard('request_on_capacity');
    requestOnCard.registerRunListener(async (args: { device_id: string; device_name: string; power_kw: number; priority: number }) => {
      if (!this.capacityGuard) return false;
      const ok = this.capacityGuard.requestOn(args.device_id, args.device_name, Number(args.power_kw), Number(args.priority) || 100);
      if (!ok) throw new Error('No capacity available');
      return true;
    });

    const forceOffCard = this.homey.flow.getActionCard('force_off_capacity');
    forceOffCard.registerRunListener(async (args: { device_id: string }) => {
      if (!this.capacityGuard) return false;
      this.capacityGuard.forceOff(args.device_id);
      return true;
    });

    const saveCapacityCard = this.homey.flow.getActionCard('save_capacity_settings');
    saveCapacityCard.registerRunListener(async (args: { limit_kw: number; margin_kw: number }) => {
      const limit = Number(args.limit_kw);
      const margin = Number(args.margin_kw);
      if (Number.isFinite(limit)) {
        this.homey.settings.set('capacity_limit_kw', limit);
        this.capacitySettings.limitKw = limit;
        if (this.capacityGuard) this.capacityGuard.setLimit(limit);
      }
      if (Number.isFinite(margin)) {
        this.homey.settings.set('capacity_margin_kw', margin);
        this.capacitySettings.marginKw = margin;
        if (this.capacityGuard) this.capacityGuard.setSoftMargin(margin);
      }
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
    if (typeof (setCapacityMode as any).registerArgumentAutocompleteListener === 'function') {
      setCapacityMode.registerArgumentAutocompleteListener('mode', async (query: string) => {
        const q = (query || '').toLowerCase();
        return Array.from(this.getAllModes())
          .filter((m) => !q || m.toLowerCase().includes(q))
          .map((m) => ({ id: m, name: m }));
      });
    }

    const setDevicePriority = this.homey.flow.getActionCard('set_device_priority');
    setDevicePriority.registerRunListener(async (args: { mode: string; device_id: string; priority: number }) => {
      const mode = (args.mode || '').trim() || this.capacityMode;
      const deviceId = (args.device_id || '').trim();
      const priority = Number(args.priority);
      if (!deviceId) throw new Error('Device ID required');
      if (!Number.isFinite(priority)) throw new Error('Priority must be a number');
      if (!this.capacityPriorities[mode]) this.capacityPriorities[mode] = {};
      this.capacityPriorities[mode][deviceId] = priority;
      this.homey.settings.set('capacity_priorities', this.capacityPriorities);
      return true;
    });

    const hasCapacityCond = this.homey.flow.getConditionCard('has_capacity_for');
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
    isCapacityModeCond.registerRunListener(async (args: { mode: string }) => {
      const chosenMode = (args.mode || '').trim();
      if (!chosenMode) return false;
      return this.capacityMode.toLowerCase() === chosenMode.toLowerCase();
    });
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
    const plan = this.buildDevicePlanSnapshot(snapshot);
    this.homey.settings.set('device_plan_snapshot', plan);
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

  private parseDeviceList(list: any[]): Array<{ id: string; name: string; targets: Array<{ id: string; value: unknown; unit: string }>; powerKw?: number; priority?: number; currentOn?: boolean; zone?: string; controllable?: boolean; currentTemperature?: number }> {
    return list
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
          zone:
            device.zone?.name ||
            (typeof device.zone === 'string' ? device.zone : undefined) ||
            device.zoneName ||
            'Unknown',
          controllable: this.controllableDevices[deviceId] ?? true,
        };
      })
      .filter(Boolean) as Array<{ id: string; name: string; targets: Array<{ id: string; value: unknown; unit: string }>; powerKw?: number; priority?: number; currentOn?: boolean; zone?: string; controllable?: boolean; currentTemperature?: number }>
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
        const headroom = (plan as any).meta?.headroomKw;
        const changes = [...plan.devices].filter((d) => {
          if (d.controllable === false) return false;
          const desiredPower = d.plannedState === 'shed' ? 'off' : 'on';
          const samePower = desiredPower === d.currentState;
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
            const powerInfo =
              typeof d.powerKw === 'number' ? `, est ${d.powerKw.toFixed(2)}kW` : '';
            const headroomInfo =
              typeof headroom === 'number' ? `, headroom ${headroom.toFixed(2)}kW` : '';
            const restoringHint =
              d.currentState === 'off' && nextPower === 'on'
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
      headroom = headroom - restoreMargin;
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
          return { ...d, priority, effectivePower: power };
        })
        .sort((a, b) => {
          const pa = (a as any).priority ?? 100;
          const pb = (b as any).priority ?? 100;
          if (pa !== pb) return pa - pb;
          return (b as any).effectivePower - (a as any).effectivePower;
        });

      let remaining = needed;
      const totalSheddable = candidates.reduce((sum, c) => sum + ((c as any).effectivePower as number), 0);
      this.log(`Plan: overshoot=${needed.toFixed(2)}kW, candidates=${candidates.length}, totalSheddable=${totalSheddable.toFixed(2)}kW`);
      for (const c of candidates) {
        if (remaining <= 0) break;
        shedSet.add(c.id);
        shedReasons.set(c.id, `shed due to capacity (priority ${c.priority ?? 100}, est ${((c as any).effectivePower as number).toFixed(2)}kW)`);
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
          if (result && typeof (result as any).catch === 'function') {
            (result as any).catch((err: Error) => this.error('Failed to trigger capacity_shortfall', err));
          }
        }
      }
    }

    const planDevices = devices.map((dev) => {
      const priority = this.getPriorityForDevice(dev.id);
      const desired = desiredForMode[dev.id];
      const plannedTarget = Number.isFinite(desired) ? Number(desired) : null;
      const currentTarget = Array.isArray(dev.targets) && dev.targets.length ? dev.targets[0].value ?? null : null;
      const currentState = typeof dev.currentOn === 'boolean' ? (dev.currentOn ? 'on' : 'off') : 'unknown';
      const controllable = dev.controllable !== false;
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

    if (headroomRaw !== null && !sheddingActive && !inCooldown && !inRestoreCooldown) {
      let availableHeadroom = headroomRaw;
      const restoredThisCycle = new Set<string>(); // Track devices restored in this planning cycle

      // Sort off devices by priority (higher priority = restore first)
      const offDevices = planDevices
        .filter((d) => d.controllable !== false && d.currentState === 'off' && d.plannedState !== 'shed')
        .sort((a, b) => (b.priority ?? 100) - (a.priority ?? 100)); // Higher priority first

      // Get ON devices sorted by priority (lower priority = shed first for swaps)
      const onDevices = planDevices
        .filter((d) => d.controllable !== false && d.currentState === 'on' && d.plannedState !== 'shed')
        .sort((a, b) => (a.priority ?? 100) - (b.priority ?? 100)); // Lower priority first

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
          const higherPriDev = planDevices.find(d => d.id === swappedFor);
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
            const swapTargetDev = planDevices.find(d => d.id === swapTargetId);
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
              }
            } else {
              // Device no longer exists, clean up
              this.pendingSwapTargets.delete(swapTargetId);
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
            if ((onDev.priority ?? 100) >= devPriority) break; // Don't shed equal or higher priority
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
            this.log(`Plan: swap approved for ${dev.name} - shedding ${toShed.map(d => d.name).join(', ')} (${toShed.reduce((sum, d) => sum + (d.powerKw ?? 1), 0).toFixed(2)}kW) to get ${potentialHeadroom.toFixed(2)}kW >= ${needed.toFixed(2)}kW needed`);
            // Track this device as a pending swap target - no lower-priority device should restore first
            this.pendingSwapTargets.add(dev.id);
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
        dev.reason = sheddingActive
          ? 'stay off while shedding is active'
          : inCooldown
            ? `stay off during cooldown (${Math.max(0, SHED_COOLDOWN_MS - (sinceShedding ?? sinceOvershoot ?? 0)) / 1000}s remaining)`
            : `stay off (waiting for power to stabilize after last restore, ${Math.max(0, RESTORE_COOLDOWN_MS - (sinceRestore ?? 0)) / 1000}s remaining)`;
        this.logDebug(`Plan: skipping restore of ${dev.name} (p${dev.priority ?? 100}, ~${(dev.powerKw ?? 1).toFixed(2)}kW) - ${dev.reason}`);
      }
    }

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
    const marginKw = this.capacitySettings.marginKw;
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

    // Allow higher instantaneous draw if budget remaining and time is short.
    const allowedKw = remainingKWh / remainingHours;
    this.logDebug(
      `Soft limit calc: budget=${netBudgetKWh.toFixed(3)}kWh used=${usedKWh.toFixed(3)}kWh remaining=${remainingKWh.toFixed(3)}kWh timeLeft=${remainingHours.toFixed(3)}h soft=${allowedKw.toFixed(3)}kW`,
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
        const reason = (dev as any).reason;
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
          this.logDebug(
            `Capacity: keeping ${name} off (${sheddingActive ? 'shedding active' : inCooldown ? 'cooldown' : wouldExceedRestoreBudget ? 'restore budget exceeded' : 'insufficient/unknown headroom'}, need ${neededForDevice.toFixed(
              3,
            )}kW, headroom ${headroom === null ? 'unknown' : headroom.toFixed(3)}, device ~${plannedPower.toFixed(2)}kW, cooldown ${inCooldown ? 'yes' : 'no'}, restored ${restoredPowerThisCycle.toFixed(2)}/${maxRestoreBudget.toFixed(2)}kW)`,
          );
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
}
