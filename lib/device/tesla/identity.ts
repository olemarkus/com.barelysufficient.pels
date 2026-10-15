import type { HomeyDeviceLike } from '../../utils/types';

export function isTeslaChargingDevice(device: HomeyDeviceLike): boolean {
  return device.driverId === 'homey:app:com.tesla.car:battery'
    && ['charging_on', 'charging_state', 'measure_charge_power', 'measure_soc_level']
      .every((capability) => device.capabilities?.includes(capability));
}

