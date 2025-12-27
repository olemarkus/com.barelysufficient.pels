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
    type StatusData = {
      headroomKw?: number;
      hourlyUsageKwh?: number;
      controlledKw?: number;
      uncontrolledKw?: number;
      shedding?: boolean;
      priceLevel?: 'cheap' | 'normal' | 'expensive' | 'unknown';
      devicesOn?: number;
      devicesOff?: number;
    };
    const status = this.homey.settings.get('pels_status') as StatusData | null;

    if (!status) return;

    try {
      const capabilityMap: Array<{ key: keyof StatusData; id: string; type: 'string' | 'number' | 'boolean' }> = [
        { key: 'headroomKw', id: 'pels_headroom', type: 'number' },
        { key: 'hourlyUsageKwh', id: 'pels_hourly_usage', type: 'number' },
        { key: 'controlledKw', id: 'pels_controlled_power', type: 'number' },
        { key: 'uncontrolledKw', id: 'pels_uncontrolled_power', type: 'number' },
        { key: 'shedding', id: 'pels_shedding', type: 'boolean' },
        { key: 'priceLevel', id: 'pels_price_level', type: 'string' },
        { key: 'devicesOn', id: 'pels_devices_on', type: 'number' },
        { key: 'devicesOff', id: 'pels_devices_off', type: 'number' },
      ];

      const shouldSetCapability = (value: unknown, type: 'string' | 'number' | 'boolean') => {
        if (type === 'string') return typeof value === 'string' && value.length > 0;
        if (type === 'number') return typeof value === 'number' && Number.isFinite(value);
        return typeof value === 'boolean';
      };

      for (const { key, id, type } of capabilityMap) {
        const value = status[key];
        if (shouldSetCapability(value, type)) {
          await this.setCapabilityValue(id, value);
        }
      }
    } catch (error) {
      this.error('Failed to update status capabilities', error);
    }
  }
}

export = PelsInsightsDevice;
