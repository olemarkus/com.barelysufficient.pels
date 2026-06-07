import Homey from 'homey';
import { getLogger } from '../../lib/logging/logger';

const driverLogger = getLogger('driver/pels-insights');

class PelsInsightsDriver extends Homey.Driver {
  async onInit(): Promise<void> {
    driverLogger.info({ event: 'pels_insights_driver_initialized' });
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
