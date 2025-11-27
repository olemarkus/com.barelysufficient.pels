'use strict';

import Homey from 'homey';

const GLOBAL_TARGET_TEMPERATURE_KEY = 'global_target_temperature';
const TARGET_CAPABILITY_PREFIXES = ['target_temperature', 'thermostat_setpoint'];
const DEBUG_LOG = false;
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { HomeyAPI } = require('homey-api');

module.exports = class MyApp extends Homey.App {
  private homeyApi?: any;

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

      if (key === 'refresh_target_devices_snapshot') {
        this.refreshTargetDevicesSnapshot().catch((error: Error) => {
          this.error('Failed to refresh target devices snapshot', error);
        });
      }
    });

    const initialTargetTemperature = this.homey.settings.get(GLOBAL_TARGET_TEMPERATURE_KEY);
    await this.applyGlobalTargetTemperature(initialTargetTemperature);
    await this.initHomeyApi();
    await this.refreshTargetDevicesSnapshot();
  }

  private logDebug(...args: any[]): void {
    if (DEBUG_LOG) this.log(...args);
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

  private async refreshTargetDevicesSnapshot(): Promise<void> {
    this.logDebug('Refreshing target devices snapshot');

    let snapshot: Array<{ id: string; name: string; targets: Array<{ id: string; value: unknown; unit: string }> }> = [];

    snapshot = await this.fetchDevicesViaApi().catch((error: Error) => {
      this.error('Manager API device fetch failed, falling back to drivers', error);
      return [];
    });

    if (snapshot.length === 0) {
      snapshot = await this.fetchDevicesViaDrivers();
    }

    this.homey.settings.set('target_devices_snapshot', snapshot);
    this.logDebug(`Stored snapshot with ${snapshot.length} devices`);
  }

  private async fetchDevicesViaApi(): Promise<Array<{ id: string; name: string; targets: Array<{ id: string; value: unknown; unit: string }> }>> {
    // Prefer the HomeyAPI helper if available.
    if (this.homeyApi) {
      try {
        const devicesObj = await this.homeyApi.devices.getDevices();
        const list = Object.values(devicesObj || {});
        this.logDebug(`HomeyAPI returned ${list.length} devices`);
        return this.parseDeviceList(list);
      } catch (error) {
        this.error('HomeyAPI.getDevices failed, falling back to raw API', error);
      }
    }

    let devices;
    try {
      devices = await this.homey.api.get('manager/devices');
    } catch (error) {
      this.logDebug('Manager API manager/devices failed, retrying devices');
      devices = await this.homey.api.get('devices');
    }
    const list = Array.isArray(devices) ? devices : Object.values(devices || {});

    this.logDebug(`Manager API returned ${list.length} devices`);

    return this.parseDeviceList(list);
  }

  private parseDeviceList(list: any[]): Array<{ id: string; name: string; targets: Array<{ id: string; value: unknown; unit: string }> }> {
    return list
      .map((device: any) => {
        const capabilities: string[] = device.capabilities || [];
        const capabilityObj = device.capabilitiesObj || {};

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
        };
      })
      .filter(Boolean) as Array<{ id: string; name: string; targets: Array<{ id: string; value: unknown; unit: string }> }>;
  }

  private async fetchDevicesViaDrivers(): Promise<Array<{ id: string; name: string; targets: Array<{ id: string; value: unknown; unit: string }> }>> {
    const results: Array<{ id: string; name: string; targets: Array<{ id: string; value: unknown; unit: string }> }> = [];

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
        });
      }
    }

    return results;
  }
}
