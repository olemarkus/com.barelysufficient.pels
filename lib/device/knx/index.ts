import type { DeviceAdapter } from '../deviceAdapter';
import { standardDeviceAdapter } from '../standardDeviceAdapter';

// KNX 1.5.2's Light driver is a generic binary actuator: `onoff` writes its
// switch group address, and the status group address reports `onoff` back.
// It can switch a non-light load, so admit this driver as a socket without
// inferring temperature control or admitting KNX dimmers and switch remotes.
const KNX_BINARY_ACTUATOR_DRIVER_ID = 'homey:app:org.knx:knx_light';

export const knxAdapter: DeviceAdapter = {
  ...standardDeviceAdapter,
  readsAsReported: true,
  matches: (device) => device.driverId === KNX_BINARY_ACTUATOR_DRIVER_ID
    && device.capabilities?.includes('onoff') === true,
  identity: (device) => ({ ...device, class: 'socket' }),
};
