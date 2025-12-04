import Homey from 'homey';

class ModeIndicatorDevice extends Homey.Device {
  async onInit(): Promise<void> {
    // Add alarm_generic capability if missing (for devices created before this capability was added)
    if (!this.hasCapability('alarm_generic')) {
      await this.addCapability('alarm_generic');
    }

    await this.updateMode(this.homey.settings.get('capacity_mode') as string || 'home');
    await this.updateShortfall(this.homey.settings.get('capacity_in_shortfall') as boolean || false);

    this.homey.settings.on('set', async (key: string) => {
      if (key === 'capacity_mode') {
        await this.updateMode(this.homey.settings.get('capacity_mode') as string || 'home');
      }
      if (key === 'capacity_in_shortfall') {
        await this.updateShortfall(this.homey.settings.get('capacity_in_shortfall') as boolean || false);
      }
    });
  }

  async updateMode(mode: string): Promise<void> {
    if (typeof mode !== 'string' || !mode.trim()) return;
    try {
      await this.setCapabilityValue('mode_indicator', mode);
    } catch (error) {
      this.error('Failed to update mode indicator', error);
    }
  }

  async updateShortfall(inShortfall: boolean): Promise<void> {
    try {
      await this.setCapabilityValue('alarm_generic', Boolean(inShortfall));
    } catch (error) {
      this.error('Failed to update shortfall alarm', error);
    }
  }
}

module.exports = ModeIndicatorDevice;
