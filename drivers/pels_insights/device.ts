import Homey from 'homey';
import { OPERATING_MODE_SETTING } from '../../lib/utils/settingsKeys';

class PelsInsightsDevice extends Homey.Device {
  async onInit(): Promise<void> {
    // Add capabilities if missing (for devices created before these were added)
    const requiredCapabilities = [
      'pels_shortfall',
      'pels_headroom',
      'pels_hourly_usage',
      'pels_controlled_power',
      'pels_uncontrolled_power',
      'pels_shedding',
      'pels_price_level',
      'pels_devices_on',
      'pels_devices_off',
    ];

    for (const cap of requiredCapabilities) {
      if (!this.hasCapability(cap)) {
        await this.addCapability(cap);
      }
    }

    // Remove deprecated alarm_generic if present (replaced by pels_shortfall)
    if (this.hasCapability('alarm_generic')) {
      await this.removeCapability('alarm_generic');
    }

    // Initialize from current settings
    const initialMode = (this.homey.settings.get(OPERATING_MODE_SETTING) as string) || 'home';
    await this.updateMode(initialMode);
    await this.updateShortfall(this.homey.settings.get('capacity_in_shortfall') as boolean || false);
    await this.updateFromStatus();

    // Listen for settings changes
    this.homey.settings.on('set', async (key: string) => {
      if (key === OPERATING_MODE_SETTING) {
        const mode = (this.homey.settings.get(OPERATING_MODE_SETTING) as string) || 'home';
        await this.updateMode(mode);
      }
      if (key === 'capacity_in_shortfall') {
        await this.updateShortfall(this.homey.settings.get('capacity_in_shortfall') as boolean || false);
      }
      if (key === 'pels_status') {
        await this.updateFromStatus();
      }
    });
  }

  async updateMode(mode: string): Promise<void> {
    if (typeof mode !== 'string' || !mode.trim()) return;
    try {
      await this.setCapabilityValue('pels_insights', mode);
    } catch (error) {
      this.error('Failed to update pels insights', error);
    }
  }

  async updateShortfall(inShortfall: boolean): Promise<void> {
    try {
      await this.setCapabilityValue('pels_shortfall', Boolean(inShortfall));
    } catch (error) {
      this.error('Failed to update shortfall alarm', error);
    }
  }

  async updateFromStatus(): Promise<void> {
    const status = this.homey.settings.get('pels_status') as {
      headroomKw?: number;
      hourlyUsageKwh?: number;
      controlledKw?: number;
      uncontrolledKw?: number;
      shedding?: boolean;
      priceLevel?: 'cheap' | 'normal' | 'expensive' | 'unknown';
      devicesOn?: number;
      devicesOff?: number;
    } | null;

    if (!status) return;

    try {
      if (typeof status.headroomKw === 'number') {
        await this.setCapabilityValue('pels_headroom', status.headroomKw);
      }
      if (typeof status.hourlyUsageKwh === 'number') {
        await this.setCapabilityValue('pels_hourly_usage', status.hourlyUsageKwh);
      }
      if (typeof status.controlledKw === 'number') {
        await this.setCapabilityValue('pels_controlled_power', status.controlledKw);
      }
      if (typeof status.uncontrolledKw === 'number') {
        await this.setCapabilityValue('pels_uncontrolled_power', status.uncontrolledKw);
      }
      if (typeof status.shedding === 'boolean') {
        await this.setCapabilityValue('pels_shedding', status.shedding);
      }
      if (status.priceLevel) {
        await this.setCapabilityValue('pels_price_level', status.priceLevel);
      }
      if (typeof status.devicesOn === 'number') {
        await this.setCapabilityValue('pels_devices_on', status.devicesOn);
      }
      if (typeof status.devicesOff === 'number') {
        await this.setCapabilityValue('pels_devices_off', status.devicesOff);
      }
    } catch (error) {
      this.error('Failed to update status capabilities', error);
    }
  }
}

export = PelsInsightsDevice;
