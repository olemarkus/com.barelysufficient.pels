'use strict';

import Homey from 'homey';

const GLOBAL_TARGET_TEMPERATURE_KEY = 'global_target_temperature';

module.exports = class MyApp extends Homey.App {

  /**
   * onInit is called when the app is initialized.
   */
  async onInit() {
    this.log('MyApp has been initialized');

    this.homey.settings.on('set', (key: string) => {
      if (key !== GLOBAL_TARGET_TEMPERATURE_KEY) {
        return;
      }

      const targetTemperature = this.homey.settings.get(GLOBAL_TARGET_TEMPERATURE_KEY);
      this.applyGlobalTargetTemperature(targetTemperature).catch((error: Error) => {
        this.error('Failed to apply target temperature from setting change', error);
      });
    });

    const initialTargetTemperature = this.homey.settings.get(GLOBAL_TARGET_TEMPERATURE_KEY);
    await this.applyGlobalTargetTemperature(initialTargetTemperature);
  }

  private async applyGlobalTargetTemperature(targetTemperature: unknown): Promise<void> {
    if (typeof targetTemperature !== 'number' || Number.isNaN(targetTemperature)) {
      this.log('Global target temperature not set or invalid, skipping device update');
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
  }

}
