import type { HomeyDeviceLike } from '../../lib/utils/types';
import type { TransportDeviceSnapshot } from '../../lib/device/transportDeviceSnapshot';
import type { HubHomeLocation } from '../../lib/device/hubHomeLocation';
import { DeviceAdapterSessions, getDeviceAdapter } from '../../lib/device/deviceAdapterRegistry';
import { hasSharedChargingInstallation, resolveChargingCurrentAction } from '../../lib/device/chargingCurrentAdapter';
import { partialDouble } from '../helpers/partialDouble';

const cap = <T>(value: T) => ({ value, lastUpdated: new Date().toISOString() });
const setup = { method: 'flow', confirmation: 'vehicle' } as const;

function vehicle(id: string): HomeyDeviceLike[] {
  const data = { id };
  return [
    { id, name: id, class: 'sensor', data, driverId: 'homey:app:com.tesla.car:battery',
      capabilities: ['charging_on', 'charging_state', 'measure_charge_power', 'measure_soc_level'],
      capabilitiesObj: { charging_on: cap(true), charging_state: cap('Charging'), measure_charge_power: cap(4),
        measure_soc_level: cap(55), charging_port_cable: cap('IEC') } },
    { id: `${id}-car`, name: id, class: 'car', data, driverId: 'homey:app:com.tesla.car:car',
      capabilitiesObj: { car_state: cap('online'), car_shift_state: cap('P'), measure_car_drive_speed: cap(0) } },
    { id: `${id}-location`, name: id, class: 'sensor', data, driverId: 'homey:app:com.tesla.car:location',
      capabilitiesObj: { measure_location_latitude: cap(60), measure_location_longitude: cap(10) } },
  ];
}

function snapshot(device: HomeyDeviceLike): TransportDeviceSnapshot {
  return partialDouble<TransportDeviceSnapshot>({ id: device.id, capabilities: device.capabilities,
    available: true, measuredPowerKw: 4 });
}

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-15T10:00:00Z')); });
afterEach(() => { vi.useRealTimers(); });

test('the generic registry isolates two vehicle sessions, their control revisions and trust recovery', () => {
  const home = partialDouble<HubHomeLocation>({ coordinates: () => ({ latitude: 60, longitude: 10 }) });
  const sessions = new DeviceAdapterSessions(home);
  sessions.setTrustEpoch('connected:1');
  const first = vehicle('first');
  const second = vehicle('second');
  sessions.observeDevices([...first, ...second]);
  const firstSnapshot = snapshot(first[0]!);
  const secondSnapshot = snapshot(second[0]!);
  expect(sessions.project(firstSnapshot, setup).available).toBe(true);
  expect(sessions.project(secondSnapshot, setup).available).toBe(true);
  const firstRevision = sessions.controlRevision('first');
  const secondRevision = sessions.controlRevision('second');
  expect(firstRevision).toBeGreaterThan(0);
  sessions.observeCapability('first-location', 'measure_location_latitude', 61);
  expect(sessions.project(firstSnapshot, setup)).toMatchObject({ available: false, measuredPowerKw: 0 });
  expect(sessions.controlRevision('first')).not.toBe(firstRevision);
  expect(sessions.project(secondSnapshot, setup).available).toBe(true);
  expect(sessions.controlRevision('second')).toBe(secondRevision);
  sessions.setTrustEpoch('disconnected:2');
  expect(sessions.project(secondSnapshot, setup)).toMatchObject({ available: false, measuredPowerKw: 0 });
  expect(sessions.controlEvents(secondSnapshot, 'measure_charge_power', 4)).toEqual([
    { capabilityId: 'measure_charge_power', value: 0 },
  ]);
});

test('vendor action arguments and installation membership are resolved by the binding owner', () => {
  const car = vehicle('car')[0]!;
  const charger: HomeyDeviceLike = { id: 'charger', name: 'Charger', driverId: 'homey:app:com.zaptec:go',
    data: { installationId: 'site' }, capabilities: ['available_installation_current'] };
  const carBinding = getDeviceAdapter(car).currentBindings(car)[0]!;
  const chargerBinding = getDeviceAdapter(charger).currentBindings(charger)[0]!;
  expect(resolveChargingCurrentAction(carBinding, [{ id: 'homey:device:car:charge_current' }], 10).args)
    .toEqual({ current: 10 });
  expect(resolveChargingCurrentAction(chargerBinding, [{ id: 'homey:device:charger:installation_current_control' }], 10).args)
    .toEqual({ current1: 10, current2: 10, current3: 10 });
  // Even a sibling without a supported current-control driver belongs to the installation.
  expect(hasSharedChargingInstallation(chargerBinding, [charger, {
    id: 'other', name: 'Other charger', driverId: 'homey:app:com.zaptec:other', data: { installationId: 'site' },
  }])).toBe(true);
});

test('an unrelated device retains standard behavior and exposes no integration control bindings', () => {
  const device: HomeyDeviceLike = { id: 'heater', name: 'Heater', class: 'heater', capabilities: ['onoff'] };
  const adapter = getDeviceAdapter(device);
  expect(adapter.identity(device)).toBe(device);
  expect(adapter.currentBindings(device)).toEqual([]);
  expect(adapter.nativeCurrentControls).toEqual([]);
});
