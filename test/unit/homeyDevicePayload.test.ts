import { fetchDevicesWithFallback } from '../../lib/device/transport/managerFetch';
import { setRestClient } from '../../lib/device/transport/managerHomeyApi';
import { parseHomeyDevicePayload } from '../../lib/device/transport/homeyDevicePayload';
import { HOMEY_DEVICE_FIELDS } from '../helpers/homeyDevicePayload';

const device = { ...HOMEY_DEVICE_FIELDS, id: 'dev-1', name: 'Heater' };
// The shape in the Tesla and Toshiba reports: no ownerUri, a driverUri and a local driverId.
const { ownerUri: _ownerUri, ...withoutOwner } = device;
const olderShape = { ...withoutOwner, driverUri: 'homey:app:com.tesla.car', driverId: 'battery' };

describe('parseHomeyDevicePayload', () => {
  it('rejects a value that is not a device record', () => {
    expect(parseHomeyDevicePayload([])).toBeNull();
    expect(parseHomeyDevicePayload(null)).toBeNull();
  });

  it('accepts a device with every field Homey sends', () => {
    expect(parseHomeyDevicePayload(device)).toMatchObject(device);
  });

  it('reads the older shape as the owner and qualified driver id', () => {
    expect(parseHomeyDevicePayload(olderShape)).toMatchObject({
      ownerUri: 'homey:app:com.tesla.car',
      driverId: 'homey:app:com.tesla.car:battery',
    });
  });

  it('leaves an already qualified driver id alone', () => {
    const driverId = 'homey:virtualdrivermatter:driver';
    expect(parseHomeyDevicePayload({ ...device, driverId })?.driverId).toBe(driverId);
  });

  it.each(['id', 'name', 'class', 'driverId', 'ownerUri', 'available', 'capabilities', 'capabilitiesObj'])(
    'drops a device without %s',
    (field) => {
      expect(parseHomeyDevicePayload({ ...device, [field]: undefined })).toBeNull();
    },
  );

  it('drops a device whose capability list holds a non-string', () => {
    expect(parseHomeyDevicePayload({ ...device, capabilities: [1] })).toBeNull();
  });

  it.each([
    ['data', {}], ['settings', {}], ['energy', null], ['energyObj', null],
    ['virtualClass', null], ['unavailableMessage', null], ['ready', null], ['zone', ''],
  ])('keeps a device without %s, read as its empty form', (field, empty) => {
    const { [field as keyof typeof device]: _omitted, ...rest } = device;
    expect(parseHomeyDevicePayload(rest)).toMatchObject({ id: 'dev-1', [field]: empty });
  });
});

describe('fetchDevicesWithFallback', () => {
  const warn = vi.fn();
  const logger = { structuredLog: { warn, info: vi.fn(), error: vi.fn() } } as never;

  beforeEach(() => warn.mockClear());

  it('returns a device in the older shape from a full read', async () => {
    setRestClient({ get: async () => [olderShape] } as never);
    const { devices } = await fetchDevicesWithFallback({ logger });
    expect(devices.map((entry) => entry.driverId)).toEqual(['homey:app:com.tesla.car:battery']);
    expect(warn).not.toHaveBeenCalled();
  });

  it('warns once when the same device keeps being rejected', async () => {
    setRestClient({ get: async () => [device, { id: 'broken' }] } as never);
    await fetchDevicesWithFallback({ logger });
    await fetchDevicesWithFallback({ logger });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({
      event: 'device_payload_rejected', deviceIds: ['broken'],
    }));
  });

  it('warns again when a device is rejected after a healthy read', async () => {
    setRestClient({ get: async () => [device, { id: 'flaky' }] } as never);
    await fetchDevicesWithFallback({ logger });
    setRestClient({ get: async () => [device] } as never);
    await fetchDevicesWithFallback({ logger });
    setRestClient({ get: async () => [device, { id: 'flaky' }] } as never);
    await fetchDevicesWithFallback({ logger });
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it('repeats the warning after an hour, not before', async () => {
    vi.useFakeTimers({ now: 0 });
    try {
      setRestClient({ get: async () => [device, { id: 'stuck' }] } as never);
      await fetchDevicesWithFallback({ logger });
      vi.setSystemTime(59 * 60 * 1000);
      await fetchDevicesWithFallback({ logger });
      expect(warn).toHaveBeenCalledTimes(1);
      vi.setSystemTime(60 * 60 * 1000);
      await fetchDevicesWithFallback({ logger });
      expect(warn).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
