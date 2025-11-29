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
  private capacityMode = 'Home';
  private capacityPriorities: Record<string, Record<string, number>> = {};
  private modeDeviceTargets: Record<string, Record<string, number>> = {};

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
        this.loadCapacitySettings();
        this.applyDeviceTargetsForMode(this.capacityMode).catch((error: Error) => {
          this.error('Failed to apply per-mode device targets', error);
        });
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
      dryRun: true,
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
    if (Number.isFinite(limit)) this.capacitySettings.limitKw = Number(limit);
    if (Number.isFinite(margin)) this.capacitySettings.marginKw = Number(margin);
    if (typeof mode === 'string' && mode.length > 0) this.capacityMode = mode;
    if (priorities && typeof priorities === 'object') this.capacityPriorities = priorities as Record<string, Record<string, number>>;
    if (modeTargets && typeof modeTargets === 'object') this.modeDeviceTargets = modeTargets as Record<string, Record<string, number>>;
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
      return;
    }

    let previousTs = state.lastTimestamp;
    let previousPower = state.lastPowerW;
    let remainingMs = nowMs - previousTs;

    while (remainingMs > 0) {
      const hourStart = this.truncateToHour(previousTs);
      const hourEnd = hourStart + 60 * 60 * 1000;
      const segmentMs = Math.min(remainingMs, hourEnd - previousTs);
      const energyKWh = (previousPower * (segmentMs / 3600000));
      const bucketKey = new Date(hourStart).toISOString();
      state.buckets[bucketKey] = (state.buckets[bucketKey] || 0) + energyKWh;

      remainingMs -= segmentMs;
      previousTs += segmentMs;
    }

    state.lastTimestamp = nowMs;
    state.lastPowerW = currentPowerW;
    if (this.capacityGuard) this.capacityGuard.reportTotalPower(currentPowerW / 1000);
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
      const mode = (args.mode || '').trim();
      if (!mode) throw new Error('Mode must be provided');
      this.capacityMode = mode;
      this.homey.settings.set('capacity_mode', mode);
      return true;
    });

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

  private async refreshTargetDevicesSnapshot(): Promise<void> {
    this.logDebug('Refreshing target devices snapshot');

    let snapshot: Array<{ id: string; name: string; targets: Array<{ id: string; value: unknown; unit: string }>; powerKw?: number }> = [];

    snapshot = await this.fetchDevicesViaApi();

    if (snapshot.length === 0) {
      snapshot = await this.fetchDevicesViaDrivers();
    }

    this.homey.settings.set('target_devices_snapshot', snapshot);
    this.logDebug(`Stored snapshot with ${snapshot.length} devices`);
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

  private parseDeviceList(list: any[]): Array<{ id: string; name: string; targets: Array<{ id: string; value: unknown; unit: string }>; powerKw?: number; priority?: number }> {
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
          this.logDebug(`(API) Device ${device.name} capabilities: ${capabilities.join(', ')}`);
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
        };
      })
      .filter(Boolean) as Array<{ id: string; name: string; targets: Array<{ id: string; value: unknown; unit: string }>; powerKw?: number; priority?: number }>;
  }

  private async fetchDevicesViaDrivers(): Promise<Array<{ id: string; name: string; targets: Array<{ id: string; value: unknown; unit: string }>; powerKw?: number; priority?: number }>> {
    const results: Array<{ id: string; name: string; targets: Array<{ id: string; value: unknown; unit: string }>; powerKw?: number; priority?: number }> = [];

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
          this.logDebug(`Device ${device.getName()} capabilities: ${deviceCaps.join(', ')}`);
          continue;
        }

        let powerKw: number | undefined;
        try {
          const power = await device.getCapabilityValue('measure_power');
          if (typeof power === 'number') {
            powerKw = power > 50 ? power / 1000 : power;
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
        });
      }
    }

    return results;
  }

  private async dryRunShedding(devices: Array<{ id: string; name: string; powerKw?: number }>): Promise<void> {
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
      .filter((d) => typeof d.powerKw === 'number' && (d.powerKw as number) > 0)
      .map((d) => ({
        ...d,
        priority: this.getPriorityForDevice(d.id),
      }))
      .sort((a, b) => {
        const pa = (a as any).priority as number;
        const pb = (b as any).priority as number;
        if (pa !== pb) return pa - pb;
        return (b.powerKw as number) - (a.powerKw as number);
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

  private getPriorityForDevice(deviceId: string): number {
    const mode = this.capacityMode || 'home';
    return this.capacityPriorities[mode]?.[deviceId] ?? 100;
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

    // Allow higher instantaneous draw if budget remaining and time is short.
    const allowedKw = remainingKWh / remainingHours;
    return allowedKw;
  }
}
