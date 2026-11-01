import type Homey from 'homey';
import api from '../../api';
import type { DeviceTransportPort } from '../../lib/device/deviceTransport';
import type { HomeyDeviceLike } from '../../lib/utils/types';
import { partialDouble } from '../helpers/partialDouble';
import { pelsHostDouble } from '../helpers/pelsHostDouble';

// While PELS is starting these routes answer the settings UI's starting error,
// which the UI retries, rather than an answer it would trust: an empty device
// list, or a price suggestion with nothing to offer.

const startingHomey = { app: undefined } as unknown as Homey.App['homey'];
const NOT_READY = /^PELS_APP_NOT_READY: /;

const hostWithDevices = (getDevicesForDebug: DeviceTransportPort['getDevicesForDebug']) => (
  { app: pelsHostDouble({ deviceManager: partialDouble<DeviceTransportPort>({ getDevicesForDebug, getZoneTree: () => null }) }) } as unknown as Homey.App['homey']
);

describe('app API routes while PELS is starting', () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    consoleSpy.mockRestore();
  });

  it('answers starting for the Homey device list instead of an empty list', async () => {
    await expect(api.homey_devices({ homey: startingHomey })).rejects.toThrow(NOT_READY);
    await expect(api.homey_devices({ homey: { app: pelsHostDouble({}) } as unknown as Homey.App['homey'] }))
      .rejects.toThrow(NOT_READY);
  });

  it('answers starting for the energy meters, the device logger and the price suggestion', async () => {
    await expect(api.homey_energy_meters({ homey: startingHomey })).rejects.toThrow(NOT_READY);
    await expect(api.log_homey_device({ homey: startingHomey, body: { id: 'dev-1' } })).rejects.toThrow(NOT_READY);
    await expect(api.ui_price_setup_suggestion({ homey: startingHomey })).rejects.toThrow(NOT_READY);
  });
});

describe('Homey device list API', () => {
  it('lists each device with the capability facts the pickers filter on', async () => {
    const devices = [
      partialDouble<HomeyDeviceLike>({ id: 'thermo', name: 'Thermometer', class: 'sensor', capabilities: ['measure_temperature'] }),
      partialDouble<HomeyDeviceLike>({ id: 'meter', name: 'Meter', capabilities: ['meter_power'] }),
      partialDouble<HomeyDeviceLike>({ id: 'bare', name: 'Bare' }),
    ];
    await expect(api.homey_devices({ homey: hostWithDevices(async () => devices) })).resolves.toEqual([
      { id: 'thermo', name: 'Thermometer', class: 'sensor', zoneName: null, hasTemperature: true, hasPower: false },
      { id: 'meter', name: 'Meter', zoneName: null, hasTemperature: false, hasPower: true },
      { id: 'bare', name: 'Bare', zoneName: null, hasTemperature: false, hasPower: false },
    ]);
  });

  it('rejects a failed read rather than answering an empty list', async () => {
    const failure = new Error('Homey device list unavailable');
    const homey = hostWithDevices(async () => { throw failure; });
    await expect(api.homey_devices({ homey })).rejects.toBe(failure);
  });
});

describe('device logger API', () => {
  it.each([undefined, null, [], {}, { id: '' }, { id: '  ' }, { id: 42 }])(
    'answers an invalid device id for %j without reading Homey', async (body) => {
      const getDevicesForDebug = vi.fn<DeviceTransportPort['getDevicesForDebug']>();
      await expect(api.log_homey_device({ homey: hostWithDevices(getDevicesForDebug), body }))
        .resolves.toEqual({ ok: false, error: 'INVALID_DEVICE_ID' });
      expect(getDevicesForDebug).not.toHaveBeenCalled();
    },
  );

  it('answers device not found for a device Homey does not list', async () => {
    const homey = hostWithDevices(async () => []);
    await expect(api.log_homey_device({ homey, body: { id: 'gone' } }))
      .resolves.toEqual({ ok: false, error: 'DEVICE_NOT_FOUND' });
  });
});
