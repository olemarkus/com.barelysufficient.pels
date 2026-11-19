import { setMockUserFlows } from '../mocks/homey';

/** Homey's saved Flow includes both cards for this device. Tests supply feedback separately. */
export function setMockSteppedLoadFlow(deviceId: string): void {
  const device = { id: deviceId };
  setMockUserFlows({
    stepped: {
      enabled: true,
      trigger: {
        id: 'homey:app:com.barelysufficient.pels:desired_stepped_load_changed',
        args: { device },
      },
      actions: [{
        id: 'homey:app:com.barelysufficient.pels:report_stepped_load_power',
        args: { device, power_w: 1000 },
      }],
    },
  });
}
