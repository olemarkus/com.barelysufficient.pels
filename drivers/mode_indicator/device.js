'use strict';

const Homey = require('homey');

class ModeIndicatorDevice extends Homey.Device {
  async onInit() {
    await this.updateMode(this.homey.settings.get('capacity_mode') || 'home');

    this.homey.settings.on('set', async (key) => {
      if (key === 'capacity_mode') {
        await this.updateMode(this.homey.settings.get('capacity_mode') || 'home');
      }
    });
  }

  async updateMode(mode) {
    if (typeof mode !== 'string' || !mode.trim()) return;
    try {
      await this.setCapabilityValue('mode_indicator', mode);
    } catch (error) {
      this.error('Failed to update mode indicator', error);
    }
  }
}

module.exports = ModeIndicatorDevice;
