import type { HomeyDeviceLike } from '../utils/types';

/** Car-link identity and read validation share the same Homey class boundary. */
export const isEvCarDeviceClass = (device: HomeyDeviceLike): boolean => {
    const deviceClass = device.class.trim().toLowerCase();
    return deviceClass === 'car' || deviceClass === 'vehicle';
};
