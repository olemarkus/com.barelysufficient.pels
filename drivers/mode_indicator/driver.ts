import Homey from 'homey';

class ModeIndicatorDriver extends Homey.Driver {
  async onInit(): Promise<void> {
    this.log('ModeIndicator driver initialized');
  }

  async onPairListDevices(): Promise<Array<{ name: string; data: { id: string } }>> {
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
