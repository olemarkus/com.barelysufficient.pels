'use strict';

import Homey from 'homey';

const GLOBAL_TARGET_TEMPERATURE_KEY = 'global_target_temperature';
const TARGET_CAPABILITY_PREFIXES = ['target_temperature', 'thermostat_setpoint'];
const DEBUG_LOG = true;
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { HomeyAPI } = require('homey-api');
import CapacityGuard from './capacityGuard';

module.exports = class MyApp extends Homey.App {
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
  private sheddingShortfallActive = false;
  private lastSetTargets: Record<string, number> = {};
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
  // Set when remaining hourly energy budget has been fully consumed (remainingKWh <= 0)
  private hourlyBudgetExhausted = false;

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
    }
  }

  /**
   * onInit is called when the app is initialized.
   */
  async onInit() {
    this.log('MyApp has been initialized');

    this.homey.settings.on('set', (key: string) => {
      if (key === GLOBAL_TARGET_TEMPERATURE_KEY) {
        const targetTemperature = this.homey.settings.get(GLOBAL_TARGET_TEMPERATURE_KEY);
        this.applyGlobalTargetTemperature(targetTemperature).catch((error: Error) => {
          this.error('Failed to apply target temperature from setting change', error);
        });
        return;
      }

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
          this.capacityGuard.setDryRun(this.capacityDryRun, async (deviceId, deviceName) => {
            await this.applySheddingToDevice(deviceId, deviceName);
          });
        }
        this.rebuildPlanFromCache();
        return;
      }

      if (key === 'capacity_dry_run') {
        this.loadCapacitySettings();
        if (this.capacityGuard) this.capacityGuard.setDryRun(this.capacityDryRun);
        this.rebuildPlanFromCache();
        return;
      }

      if (key === 'refresh_target_devices_snapshot') {
        this.refreshTargetDevicesSnapshot().catch((error: Error) => {
          this.error('Failed to refresh target devices snapshot', error);
        });
      }
    });

    const initialTargetTemperature = this.homey.settings.get(GLOBAL_TARGET_TEMPERATURE_KEY);
    await this.applyGlobalTargetTemperature(initialTargetTemperature);
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
    this.capacityGuard.setDryRun(this.capacityDryRun, async (deviceId, deviceName) => {
      await this.applySheddingToDevice(deviceId, deviceName);
    });
    this.capacityGuard.start();
    await this.refreshTargetDevicesSnapshot();
    await this.applyDeviceTargetsForMode(this.capacityMode);
    this.registerFlowCards();
    this.loadPowerTracker();
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
      this.rebuildPlanFromCache();
      this.savePowerTracker();
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
    setCapacityMode.registerRunListener(async (args: { mode: string }) => {
      const chosen = (args.mode || '').trim();
      if (!chosen) throw new Error('Mode must be provided');
      this.capacityMode = chosen;
      this.homey.settings.set('capacity_mode', chosen);
      this.rebuildPlanFromCache();
      await this.previewDeviceTargetsForMode(chosen);
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
  }

  private async applyGlobalTargetTemperature(targetTemperature: unknown): Promise<void> {
    if (typeof targetTemperature !== 'number' || Number.isNaN(targetTemperature)) {
      this.log('Global target temperature not set or invalid, skipping device update');
      await this.refreshTargetDevicesSnapshot();
      return;
    }

    const drivers = this.homey.drivers.getDrivers();
    for (const driver of Object.values(drivers)) {
      try {
        await driver.ready();
      } catch (error) {
        this.error(`Driver ${driver.id} is not ready, skipping devices`, error);
        continue;
      }

      const devices = driver.getDevices();
      for (const device of devices) {
        const targetCapabilities = device.getCapabilities().filter((capability) => capability.startsWith('target_temperature'));
        if (targetCapabilities.length === 0) {
          continue;
        }

        try {
          await device.ready();
        } catch (error) {
          this.error(`Device ${device.getName()} is not ready`, error);
          continue;
        }

        for (const capabilityId of targetCapabilities) {
          try {
            await device.setCapabilityValue(capabilityId, targetTemperature);
            this.log(`Set ${capabilityId} for ${device.getName()} to ${targetTemperature}`);
          } catch (error) {
            this.error(`Failed to set ${capabilityId} for ${device.getName()}`, error);
          }
        }
      }
    }

    await this.refreshTargetDevicesSnapshot();
  }

  private async applyDeviceTargetsForMode(mode: string): Promise<void> {
    const targets = this.modeDeviceTargets[mode];
    if (!targets || typeof targets !== 'object') {
      this.log(`No device targets configured for mode ${mode}`);
      return;
    }

    const drivers = this.homey.drivers.getDrivers();
    for (const driver of Object.values(drivers)) {
      try {
        await driver.ready();
      } catch (error) {
        this.error(`Driver ${driver.id} is not ready, skipping devices`, error);
        continue;
      }

      const devices = driver.getDevices();
      for (const device of devices) {
        const deviceId = device.getData ? device.getData().id || device.getName() : device.getName();
        const targetValue = targets[deviceId];
        if (typeof targetValue !== 'number' || Number.isNaN(targetValue)) continue;

        const targetCapabilities = device.getCapabilities().filter((capability) => TARGET_CAPABILITY_PREFIXES.some((prefix) => capability.startsWith(prefix)));
        if (targetCapabilities.length === 0) continue;

        try {
          await device.ready();
        } catch (error) {
          this.error(`Device ${device.getName()} is not ready`, error);
          continue;
        }

        for (const capabilityId of targetCapabilities) {
          try {
            await device.setCapabilityValue(capabilityId, targetValue);
            this.log(`Set ${capabilityId} for ${device.getName()} to ${targetValue} (${mode})`);
          } catch (error) {
            this.error(`Failed to set ${capabilityId} for ${device.getName()}`, error);
          }
        }
      }
    }

    await this.refreshTargetDevicesSnapshot();
  }

  private async previewDeviceTargetsForMode(mode: string): Promise<void> {
    const targets = this.modeDeviceTargets[mode];
    if (!targets || typeof targets !== 'object') {
      this.log(`Dry-run mode change: no device targets configured for mode ${mode}`);
      return;
    }

    const drivers = this.homey.drivers.getDrivers();
    for (const driver of Object.values(drivers)) {
      try {
        await driver.ready();
      } catch {
        continue;
      }

      const devices = driver.getDevices();
      for (const device of devices) {
        const deviceId = device.getData ? device.getData().id || device.getName() : device.getName();
        const targetValue = targets[deviceId];
        if (typeof targetValue !== 'number' || Number.isNaN(targetValue)) continue;

        const targetCapabilities = device.getCapabilities().filter((capability) => TARGET_CAPABILITY_PREFIXES.some((prefix) => capability.startsWith(prefix)));
        if (targetCapabilities.length === 0) continue;

        targetCapabilities.forEach((capId) => {
          this.log(`Dry-run: would set ${capId} for ${device.getName()} to ${targetValue}°C (mode ${mode})`);
        });
      }
    }
  }

  private async refreshTargetDevicesSnapshot(): Promise<void> {
    this.logDebug('Refreshing target devices snapshot');

    let snapshot: Array<{ id: string; name: string; targets: Array<{ id: string; value: unknown; unit: string }>; powerKw?: number }> = [];

    snapshot = await this.fetchDevicesViaApi();

    if (snapshot.length === 0) {
      snapshot = await this.fetchDevicesViaDrivers();
    }

    this.homey.settings.set('target_devices_snapshot', snapshot);
    this.latestTargetSnapshot = snapshot;
    this.syncGuardFromSnapshot(snapshot);
    this.logDebug(`Stored snapshot with ${snapshot.length} devices`);
    const plan = this.buildDevicePlanSnapshot(snapshot);
    this.homey.settings.set('device_plan_snapshot', plan);
    await this.dryRunShedding(snapshot);
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

  private parseDeviceList(list: any[]): Array<{ id: string; name: string; targets: Array<{ id: string; value: unknown; unit: string }>; powerKw?: number; priority?: number; currentOn?: boolean; zone?: string; controllable?: boolean }> {
    return list
      .map((device: any) => {
        const capabilities: string[] = device.capabilities || [];
        const capabilityObj = device.capabilitiesObj || {};
        const powerRaw = capabilityObj.measure_power?.value;
        let powerKw: number | undefined;
        if (typeof powerRaw === 'number') {
          powerKw = powerRaw > 50 ? powerRaw / 1000 : powerRaw;
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

        return {
          id: device.id || device.data?.id || device.name,
          name: device.name,
          targets,
          powerKw,
          priority: this.getPriorityForDevice(device.id || device.data?.id || device.name),
          currentOn: typeof capabilityObj.onoff?.value === 'boolean' ? capabilityObj.onoff.value : undefined,
          // Prefer modern zone structure; fall back to legacy to avoid deprecation warning.
          zone:
            device.zone?.name ||
            (typeof device.zone === 'string' ? device.zone : undefined) ||
            device.zoneName ||
            'Unknown',
          controllable: this.controllableDevices[device.id || device.data?.id || device.name] ?? true,
        };
      })
      .filter(Boolean) as Array<{ id: string; name: string; targets: Array<{ id: string; value: unknown; unit: string }>; powerKw?: number; priority?: number; currentOn?: boolean; zone?: string; controllable?: boolean }>;
  }

  private async fetchDevicesViaDrivers(): Promise<Array<{ id: string; name: string; targets: Array<{ id: string; value: unknown; unit: string }>; powerKw?: number; priority?: number; currentOn?: boolean; zone?: string; controllable?: boolean }>> {
    const results: Array<{ id: string; name: string; targets: Array<{ id: string; value: unknown; unit: string }>; powerKw?: number; priority?: number; currentOn?: boolean; zone?: string; controllable?: boolean }> = [];

    const drivers = this.homey.drivers.getDrivers();
    this.logDebug(`Found ${Object.keys(drivers).length} drivers`);

    for (const driver of Object.values(drivers)) {
      try {
        await driver.ready();
      } catch (error) {
        this.error(`Driver ${driver.id} is not ready, skipping devices for snapshot`, error);
        continue;
      }

      const devices = driver.getDevices();
      this.logDebug(`Driver ${driver.id} has ${devices.length} devices`);
      for (const device of devices) {
        const deviceCaps = device.getCapabilities();
        const targetCapabilities = deviceCaps.filter((capability) => TARGET_CAPABILITY_PREFIXES.some((prefix) => capability.startsWith(prefix)));
        if (targetCapabilities.length === 0) {
          continue;
        }

        let powerKw: number | undefined;
        let onoffValue: boolean | undefined;
        try {
          const power = await device.getCapabilityValue('measure_power');
          if (typeof power === 'number') {
            powerKw = power > 50 ? power / 1000 : power;
          }
        } catch (err) {
          // ignore
        }
        try {
          const onoff = await device.getCapabilityValue('onoff');
          if (typeof onoff === 'boolean') {
            onoffValue = onoff;
          }
        } catch (err) {
          // ignore
        }

        try {
          await device.ready();
        } catch (error) {
          this.error(`Device ${device.getName()} is not ready for snapshot`, error);
          continue;
        }

        const targets = [];
        for (const capabilityId of targetCapabilities) {
          try {
            const value = await device.getCapabilityValue(capabilityId);
            targets.push({
              id: capabilityId,
              value: value ?? null,
              unit: '°C',
            });
          } catch (error) {
            this.error(`Failed to read ${capabilityId} for ${device.getName()}`, error);
          }
        }

        results.push({
          id: device.getData ? device.getData().id || device.getName() : device.getName(),
          name: device.getName(),
          targets,
          powerKw,
          priority: this.getPriorityForDevice(device.getData ? device.getData().id || device.getName() : device.getName()),
          currentOn: typeof onoffValue === 'boolean' ? onoffValue : undefined,
          controllable: this.controllableDevices[device.getData ? device.getData().id || device.getName() : device.getName()] ?? true,
        });
      }
    }

    return results;
  }

  private async dryRunShedding(devices: Array<{ id: string; name: string; powerKw?: number; controllable?: boolean }>): Promise<void> {
    if (!this.capacityGuard) return;
    const total = this.capacityGuard.getLastTotalPower();
    if (total === null) {
      this.logDebug('Dry run: total power unknown, skipping');
      return;
    }
    const softLimit = Math.max(0, this.capacitySettings.limitKw - this.capacitySettings.marginKw);
    const headroom = softLimit - total;
    if (headroom >= 0) {
      this.logDebug(`Dry run: within limit. Total=${total.toFixed(2)}kW soft=${softLimit.toFixed(2)}kW`);
      return;
    }

    const needed = -headroom;
    const candidates = devices
      .filter((d) => d.controllable !== false)
      .map((d) => {
        const priority = this.getPriorityForDevice(d.id);
        const power = typeof d.powerKw === 'number' && d.powerKw > 0 ? d.powerKw : 1; // fallback if unknown
        return { ...d, priority, effectivePower: power };
      })
      .sort((a, b) => {
        const pa = (a as any).priority as number;
        const pb = (b as any).priority as number;
        if (pa !== pb) return pa - pb;
        return (b as any).effectivePower - (a as any).effectivePower;
      });

    let remaining = needed;
    const shedList: Array<{ name: string; powerKw: number }> = [];
    for (const d of candidates) {
      if (remaining <= 0) break;
      shedList.push({ name: d.name, powerKw: d.powerKw as number });
      remaining -= d.powerKw as number;
    }

    if (!shedList.length) {
      this.logDebug(`Dry run: over limit by ${needed.toFixed(2)}kW but no power readings to shed.`);
      return;
    }

    const names = shedList.map((s) => `${s.name} (${s.powerKw.toFixed(2)}kW)`).join(', ');
    this.logDebug(`Dry run: total=${total.toFixed(2)}kW soft=${softLimit.toFixed(2)}kW, would shed: ${names}`);
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
        const lines = [...plan.devices]
          .filter((d) => d.controllable !== false)
          .sort((a, b) => {
            const pa = a.priority ?? 999;
            const pb = b.priority ?? 999;
            if (pa !== pb) return pa - pb;
            return (a.name || '').localeCompare(b.name || '');
          })
          .map((d) => {
            const temp = `${d.currentTarget ?? '–'}° -> ${d.plannedTarget ?? '–'}°`;
            const nextPower = d.plannedState === 'shed' ? 'off' : d.currentState === 'off' ? 'off' : 'on';
            const power = `${d.currentState} -> ${nextPower}`;
            return `${d.name}: temp ${temp}, power ${power}, reason: ${d.reason ?? 'n/a'}`;
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

  private buildDevicePlanSnapshot(devices: Array<{ id: string; name: string; targets: Array<{ id: string; value: unknown; unit: string }>; powerKw?: number; priority?: number; currentOn?: boolean; zone?: string; controllable?: boolean }>): {
    meta: { totalKw: number | null; softLimitKw: number; headroomKw: number | null; hourlyBudgetExhausted?: boolean };
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
    }>;
  } {
    const desiredForMode = this.modeDeviceTargets[this.capacityMode] || {};
    const total = this.capacityGuard ? this.capacityGuard.getLastTotalPower() : null;
    const softLimit = this.computeDynamicSoftLimit();
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

    const sheddingActive = this.capacityGuard ? (this.capacityGuard as any).isSheddingActive?.() === true : false;
    const shedSet = new Set<string>();
    const shedReasons = new Map<string, string>();
    const restoreMarginPlanning = Math.max(0.1, this.capacitySettings.marginKw || 0);
    if (headroom !== null && headroom < 0) {
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
      for (const c of candidates) {
        if (remaining <= 0) break;
        shedSet.add(c.id);
        shedReasons.set(c.id, `shed due to capacity (priority ${c.priority ?? 100}, est ${((c as any).effectivePower as number).toFixed(2)}kW)`);
        remaining -= (c as any).effectivePower as number;
      }

      if (remaining > 0) {
        // Even after shedding all controllable ON devices we are still over budget.
        const deficitKw = remaining;
        const msg = `Capacity shortfall: cannot reach soft limit, deficit ~${deficitKw.toFixed(2)}kW (total ${
          total === null ? 'unknown' : total.toFixed(2)
        }kW, soft ${softLimit.toFixed(2)}kW)`;
        if (!this.sheddingShortfallActive) {
          this.log(msg);
          const card = this.homey.flow?.getTriggerCard?.('capacity_shortfall');
          if (card && typeof card.trigger === 'function') {
            const result = card.trigger({
              deficit_kw: Number(deficitKw.toFixed(3)),
              total_kw: total === null ? null : Number(total.toFixed(3)),
              soft_limit_kw: Number(softLimit.toFixed(3)),
            });
            if (result && typeof (result as any).catch === 'function') {
              (result as any).catch((err: Error) => this.error('Failed to trigger capacity_shortfall', err));
            }
          }
        } else {
          this.logDebug(msg);
        }
        this.sheddingShortfallActive = true;
      } else if (this.sheddingShortfallActive) {
        // Clear shortfall flag once we have enough candidates to cover the deficit.
        this.sheddingShortfallActive = false;
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
      };
    });

    // Secondary guard: if a device is currently off and headroom is still below what it needs plus margin,
    // keep it shed to avoid on/off flapping.
    if (headroomRaw !== null) {
      for (const dev of planDevices) {
        if (dev.controllable === false) continue;
        if (dev.currentState !== 'off') continue;
        if (dev.plannedState === 'shed') continue;
        const needed = (dev.powerKw && dev.powerKw > 0 ? dev.powerKw : 1) + restoreMarginPlanning;
        if (headroomRaw < needed || sheddingActive) {
          dev.plannedState = 'shed';
          dev.reason = sheddingActive
            ? 'stay off while shedding is active'
            : `stay off until headroom >= ${needed.toFixed(2)}kW`;
        }
      }
    }

    return {
      meta: {
        totalKw: total,
        softLimitKw: softLimit,
        headroomKw: headroom,
        hourlyBudgetExhausted: this.hourlyBudgetExhausted,
      },
      devices: planDevices,
    };
  }

  private syncGuardFromSnapshot(snapshot: Array<{ id: string; name: string; powerKw?: number; priority?: number; currentOn?: boolean; controllable?: boolean }>): void {
    if (!this.capacityGuard) return;
    const guardAny: any = this.capacityGuard as any;
    const hasHelper = typeof guardAny.setControllables === 'function';
    const controllables = snapshot
      .filter((d) => d.controllable !== false)
      .map((d) => ({
        id: d.id,
        name: d.name,
        powerKw: typeof d.powerKw === 'number' && d.powerKw > 0 ? d.powerKw : 1,
        priority: this.getPriorityForDevice(d.id),
        on: d.currentOn === true,
      }));
    if (hasHelper) {
      guardAny.setControllables(controllables);
      return;
    }

    // Fallback for older CapacityGuard builds: manually reset the internal map.
    if (guardAny.controllables && typeof guardAny.controllables.clear === 'function') {
      guardAny.controllables.clear();
      for (const dev of controllables) {
        guardAny.controllables.set(dev.id, {
          name: dev.name,
          powerKw: dev.powerKw,
          priority: dev.priority,
          desired: dev.on ? 'ON' : 'OFF',
        });
      }
      if (typeof guardAny.recomputeAllocation === 'function') {
        guardAny.recomputeAllocation();
      }
    }
  }

  private getPriorityForDevice(deviceId: string): number {
    const mode = this.capacityMode || 'Home';
    return this.capacityPriorities[mode]?.[deviceId] ?? 100;
  }

  private getAllModes(): Set<string> {
    const modes = new Set<string>();
    const defaults = ['Home', 'Away', 'Vacation', 'Home Office'];
    defaults.forEach((m) => modes.add(m));
    if (this.capacityMode) modes.add(this.capacityMode);
    Object.keys(this.capacityPriorities || {}).forEach((m) => {
      if (m && m.trim()) modes.add(m);
    });
    Object.keys(this.modeDeviceTargets || {}).forEach((m) => {
      if (m && m.trim()) modes.add(m);
    });
    if (!modes.size) modes.add('Home');
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
    const elapsedMs = now - hourStart;
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

  private async findDeviceInstance(deviceId: string): Promise<any | null> {
    if (!deviceId) return null;
    const target = String(deviceId);
    const drivers = this.homey.drivers.getDrivers();
    for (const driver of Object.values(drivers)) {
      try {
        await driver.ready();
      } catch {
        continue;
      }
      for (const device of driver.getDevices()) {
        const data = device.getData ? device.getData() : {};
        const candidates = [
          data?.id,
          data?.uuid,
          (device as any).id,
        ]
          .filter((v) => v !== undefined && v !== null)
          .map((v) => String(v));
        if (candidates.includes(target)) {
          return device;
        }
      }
    }
    return null;
  }

  private async applySheddingToDevice(deviceId: string, deviceName?: string): Promise<void> {
    if (this.capacityDryRun) return;
    const snapshotState = this.latestTargetSnapshot.find((d) => d.id === deviceId);
    if (snapshotState && snapshotState.currentOn === false) {
      this.logDebug(`Actuator: skip shedding ${deviceName || deviceId}, already off in snapshot`);
      return;
    }
    const name = deviceName || deviceId;
    const device = await this.findDeviceInstance(deviceId);
    if (device) {
      const caps = device.getCapabilities ? device.getCapabilities() : [];
      if (!caps.includes('onoff')) {
        this.logDebug(`Actuator: device ${name} has no onoff capability, skipping`);
        return;
      }
      try {
        await device.setCapabilityValue('onoff', false);
        this.log(`Actuator: turned off ${name} due to capacity`);
        this.updateLocalSnapshot(deviceId, { on: false });
        return;
      } catch (error) {
        this.error(`Failed to turn off ${name} via driver`, error);
      }
    }

    // Fallback to Homey API if driver lookup failed.
    if (this.homeyApi && this.homeyApi.devices && typeof this.homeyApi.devices.setCapabilityValue === 'function') {
      try {
        await this.homeyApi.devices.setCapabilityValue({ deviceId, capabilityId: 'onoff', value: false });
        this.log(`Actuator: turned off ${name} via HomeyAPI`);
        this.updateLocalSnapshot(deviceId, { on: false });
        return;
      } catch (error) {
        this.error(`Failed to turn off ${name} via HomeyAPI`, error);
      }
    }

    this.logDebug(`Actuator: device ${name} not found for shedding (id lookup only)`);
  }

  private async applyPlanActions(plan: { devices: Array<{ id: string; name?: string; plannedState: string; currentState: string; plannedTarget: number | null; currentTarget: any; controllable?: boolean }> }): Promise<void> {
    if (!plan || !Array.isArray(plan.devices)) return;
    for (const dev of plan.devices) {
      if (dev.controllable === false) continue;
      // Apply on/off when shedding.
      if (dev.plannedState === 'shed' && dev.currentState !== 'off') {
        this.log(`Capacity: turning off ${dev.name || dev.id} due to shedding`);
        await this.applySheddingToDevice(dev.id, dev.name);
        continue;
      }
      // Restore power if the plan keeps it on and it was off.
      if (dev.plannedState !== 'shed' && dev.currentState === 'off') {
        const name = dev.name || dev.id;
        // Skip turning back on unless we have some headroom to avoid flapping.
        const headroom = this.capacityGuard ? this.capacityGuard.getHeadroom() : null;
        const sheddingActive = (this.capacityGuard as any)?.isSheddingActive?.() === true;
        const restoreMargin = Math.max(0.1, this.capacitySettings.marginKw || 0);
        const neededForDevice = ((dev as any).powerKw && (dev as any).powerKw > 0 ? (dev as any).powerKw : 1) + restoreMargin;
        // Do not restore devices while shedding is active, when headroom is unknown,
        // or when there is insufficient headroom for this device plus margin.
        if (sheddingActive || headroom === null || headroom < neededForDevice) {
          this.logDebug(
            `Capacity: keeping ${name} off (${sheddingActive ? 'shedding active' : 'insufficient/unknown headroom'}, need ${neededForDevice.toFixed(
              3,
            )}kW, headroom ${headroom === null ? 'unknown' : headroom.toFixed(3)})`,
          );
          continue;
        }
        const device = await this.findDeviceInstance(dev.id);
        if (device) {
          const caps = device.getCapabilities ? device.getCapabilities() : [];
          if (caps.includes('onoff')) {
            try {
              await device.setCapabilityValue('onoff', true);
              this.log(`Capacity: turning on ${name} (restored from shed/off state)`);
              this.updateLocalSnapshot(dev.id, { on: true });
              continue;
            } catch (error) {
              this.error(`Failed to turn on ${name} via driver`, error);
            }
          }
        }

        if (this.homeyApi && this.homeyApi.devices && typeof this.homeyApi.devices.setCapabilityValue === 'function') {
          try {
            await this.homeyApi.devices.setCapabilityValue({ deviceId: dev.id, capabilityId: 'onoff', value: true });
            this.log(`Capacity: turning on ${name} via HomeyAPI (restored from shed/off state)`);
            this.updateLocalSnapshot(dev.id, { on: true });
          } catch (error) {
            this.error(`Failed to turn on ${name} via HomeyAPI`, error);
          }
        }
      }

      // Apply target temperature changes.
      if (typeof dev.plannedTarget === 'number' && dev.plannedTarget !== dev.currentTarget) {
        if (this.lastSetTargets[dev.id] === dev.plannedTarget) {
          this.logDebug(`Skip setting ${dev.name || dev.id} target to ${dev.plannedTarget} (already set)`);
          continue;
        }
        const snapshot = this.latestTargetSnapshot.find((d) => d.id === dev.id);
        const targetCap = snapshot?.targets?.[0]?.id;
        if (!targetCap) continue;

        // Try driver first.
        const device = await this.findDeviceInstance(dev.id);
        if (device) {
          try {
            await device.setCapabilityValue(targetCap, dev.plannedTarget);
            this.log(
              `Set ${targetCap} for ${dev.name || dev.id} ${dev.currentTarget === undefined || dev.currentTarget === null ? '' : `from ${dev.currentTarget} `}to ${
                dev.plannedTarget
              }`,
            );
            this.updateLocalSnapshot(dev.id, { target: dev.plannedTarget });
            this.lastSetTargets[dev.id] = dev.plannedTarget;
            continue;
          } catch (error) {
            this.error(`Failed to set ${targetCap} for ${dev.name || dev.id} via driver`, error);
          }
        }

        // Fallback to Homey API if available.
        if (this.homeyApi && this.homeyApi.devices && typeof this.homeyApi.devices.setCapabilityValue === 'function') {
          try {
            await this.homeyApi.devices.setCapabilityValue({
              deviceId: dev.id,
              capabilityId: targetCap,
              value: dev.plannedTarget,
            });
            this.log(
              `Set ${targetCap} for ${dev.name || dev.id} ${dev.currentTarget === undefined || dev.currentTarget === null ? '' : `from ${dev.currentTarget} `}to ${
                dev.plannedTarget
              } via HomeyAPI`,
            );
            this.updateLocalSnapshot(dev.id, { target: dev.plannedTarget });
            this.lastSetTargets[dev.id] = dev.plannedTarget;
          } catch (error) {
            this.error(`Failed to set ${targetCap} for ${dev.name || dev.id} via HomeyAPI`, error);
          }
        }
      }
    }
  }
}
