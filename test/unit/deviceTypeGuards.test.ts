import { isHomeyDeviceLike } from '../../lib/utils/types';
import { HOMEY_DEVICE_FIELDS } from '../helpers/homeyDevicePayload';

describe('isHomeyDeviceLike', () => {
  it('rejects arrays', () => {
    expect(isHomeyDeviceLike([])).toBe(false);
  });

  const device = { ...HOMEY_DEVICE_FIELDS, id: 'dev-1', name: 'Heater' };

  it('accepts a device with every field Homey sends', () => {
    expect(isHomeyDeviceLike(device)).toBe(true);
  });

  it.each(Object.keys(device))('drops a device without %s', (field) => {
    expect(isHomeyDeviceLike({ ...device, [field]: undefined })).toBe(false);
  });

  it('drops a device whose capability list holds a non-string', () => {
    expect(isHomeyDeviceLike({ ...device, capabilities: [1] })).toBe(false);
  });
});
