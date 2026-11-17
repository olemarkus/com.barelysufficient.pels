import type { DeviceDescriptor } from '../../contracts/src/types';

type DevicePowerSupport = Pick<DeviceDescriptor,
  'binaryControllable' | 'isEvCharger' | 'powerCapable' | 'capabilities'>;

/** Native on/off control can be managed before Homey has any power information for it. */
export const needsHomeyEnergySetup = (device: DevicePowerSupport | null | undefined): boolean => (
  device?.binaryControllable === true
  && !device.isEvCharger
  && device.powerCapable === false
  && device.capabilities?.includes('onoff') === true
);

export const HOMEY_ENERGY_SETUP_REASON = 'Set “Energy used when on” in this device’s Advanced settings in Homey';

export const HOMEY_ENERGY_SETUP_HINT = 'PELS is not limiting this device. Open the device in Homey, go to '
  + 'Advanced settings → Energy, and set “Energy used when on” to the watts it draws when on.';

export const HOMEY_ENERGY_SETUP_DOCS_URL = 'https://pels.barelysufficient.org/configuration#device-energy-settings';
