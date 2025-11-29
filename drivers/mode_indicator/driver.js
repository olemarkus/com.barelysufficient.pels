'use strict';

const Homey = require('homey');

class ModeIndicatorDriver extends Homey.Driver {
  async onInit() {
    this.log('ModeIndicator driver initialized');
  }

  async onPairListDevices() {
    const uniqueId = `capacity-mode-indicator-${Date.now()}`;
    return [
      {
        name: this.homey.__('mode_indicator.name') || 'Capacity mode',
        data: {
          id: uniqueId,
        },
      },
    ];
  }
}

module.exports = ModeIndicatorDriver;
