import type Homey from 'homey';
import type { HomeyDeviceLike } from '../../lib/utils/types';
import { getLogger } from '../../lib/logging/logger';
import { setRestClient } from '../../lib/device/transport/managerHomeyApi';
import { findDeviceReadContractViolation } from '../../lib/device/transport/deviceReadContract';
import {
  createTestDeviceTransport, initWithLiveFeed, seedTransportDevices, onObservedState,
} from '../helpers/deviceTransportHarness';
import { emitCapability } from '../helpers/liveFeedSocketHarness';
import { mockHomeyInstance, setMockGeolocation } from '../mocks/homey';

const cap = <T>(value: T) => ({ value, lastUpdated: new Date().toISOString() });

function devices(): HomeyDeviceLike[] {
  const data = { id: 'vehicle' };
  return [
    { id: 'battery', name: 'Car battery', class: 'sensor', data,
      driverId: 'homey:app:com.tesla.car:battery',
      capabilities: ['charging_on', 'charging_state', 'measure_charge_power', 'measure_soc_level'],
      capabilitiesObj: { charging_on: cap(true), charging_state: cap('Charging'),
        measure_charge_current_max: cap(16), measure_charge_current: cap(6), measure_charge_power: cap(4),
        measure_soc_level: cap(55), charging_port_cable: cap('IEC') } },
    { id: 'location', name: 'Location', class: 'sensor', data,
      driverId: 'homey:app:com.tesla.car:location',
      capabilities: ['measure_location_latitude', 'measure_location_longitude'],
      capabilitiesObj: { measure_location_latitude: cap(60), measure_location_longitude: cap(10) } },
    { id: 'car', name: 'Car', class: 'car', data, driverId: 'homey:app:com.tesla.car:car',
      capabilities: ['car_state', 'car_shift_state', 'measure_car_drive_speed'],
      capabilitiesObj: { car_state: cap('online'), car_shift_state: cap('P'), measure_car_drive_speed: cap(0) } },
  ];
}

beforeEach(() => {
  setMockGeolocation(60, 10);
  setRestClient({ get: (path) => mockHomeyInstance.api.get(path),
    put: (path, body) => mockHomeyInstance.api.put(path, body) });
  mockHomeyInstance.settings.set('charging_current_control', {
    battery: { method: 'flow', confirmation: 'vehicle' },
  });
});

afterEach(() => {
  setMockGeolocation(59.91, 10.75);
  mockHomeyInstance.settings.unset('charging_current_control');
});

test.each(['not-a-vendor-state', '', null, 12])(
  'rejects malformed realtime state %s before changing session or publishing feedback', async (value) => {
    const transport = createTestDeviceTransport(mockHomeyInstance as unknown as Homey.App,
      { log: vi.fn(), error: vi.fn(), structuredLog: getLogger('test') });
    await initWithLiveFeed(transport);
    const initial = devices();
    await seedTransportDevices(transport, initial);
    const before = structuredClone(transport.getSnapshotByDeviceId('battery'));
    const observed = vi.fn();
    onObservedState(transport, observed);

    expect(findDeviceReadContractViolation({ ...initial[0]!, capabilitiesObj: {
      ...initial[0]!.capabilitiesObj, charging_state: cap(value),
    } })).toEqual({ reason: 'unexpected_value', capabilityId: 'charging_state' });
    await emitCapability('battery', 'charging_state', value);

    expect(transport.getSnapshotByDeviceId('battery')).toEqual(before);
    expect(observed).not.toHaveBeenCalled();
  },
);

test.each(['Unknown', 'NoPower', 'Calibrating'])(
  'accepts realtime %s as control revocation without inventing an unplug', async (value) => {
    const transport = createTestDeviceTransport(mockHomeyInstance as unknown as Homey.App,
      { log: vi.fn(), error: vi.fn(), structuredLog: getLogger('test') });
    await initWithLiveFeed(transport);
    const initial = devices();
    await seedTransportDevices(transport, initial);
    expect(transport.getSnapshotByDeviceId('battery')).toMatchObject({ available: true, measuredPowerKw: 4 });
    expect(findDeviceReadContractViolation({ ...initial[0]!, capabilitiesObj: {
      ...initial[0]!.capabilitiesObj, charging_state: cap(value),
    } })).toBeNull();

    await emitCapability('battery', 'charging_state', value);

    expect(transport.getSnapshotByDeviceId('battery')).toMatchObject({
      available: false, measuredPowerKw: 0, evChargingState: 'plugged_in_charging',
    });
  },
);
