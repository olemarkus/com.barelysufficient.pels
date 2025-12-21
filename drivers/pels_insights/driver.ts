import Homey from 'homey';

class PelsInsightsDriver extends Homey.Driver {
  async onInit(): Promise<void> {
    this.log('PELS Insights driver initialized');
  }

  async onPairListDevices(): Promise<Array<{ name: string; data: { id: string } }>> {
    const uniqueId = `pels-insights-${Date.now()}`;
    return [
      {
        name: this.homey.__('pels_insights.name') || 'PELS Insights',
        data: {
          id: uniqueId,
        },
      },
    ];
  }
}

export = PelsInsightsDriver;
