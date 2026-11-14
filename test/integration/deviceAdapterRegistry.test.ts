import type { HomeyDeviceLike } from '../../lib/utils/types';
import type { TransportDeviceSnapshot } from '../../lib/device/transportDeviceSnapshot';
import type { HubHomeLocation } from '../../lib/device/hubHomeLocation';
import { DeviceAdapterSessions, getDeviceAdapter } from '../../lib/device/deviceAdapterRegistry';
import { hasSharedChargingInstallation, resolveChargingCurrentAction } from '../../lib/device/chargingCurrentAdapter';
import { partialDouble } from '../helpers/partialDouble';
import { FuturehomeChargerSession } from '../../lib/device/futurehome/session';
import { HOMEY_DEVICE_FIELDS } from '../helpers/homeyDevicePayload';
import { standardDeviceAdapter } from '../../lib/device/standardDeviceAdapter';

const cap = <T>(value: T) => ({ value, lastUpdated: new Date().toISOString() });
const setup = { method: 'flow', confirmation: 'vehicle' } as const;

function vehicle(id: string): HomeyDeviceLike[] {
  const data = { id };
  return [
    { ...HOMEY_DEVICE_FIELDS, id, name: id, class: 'sensor', data, driverId: 'homey:app:com.tesla.car:battery',
      capabilities: ['charging_on', 'charging_state', 'measure_charge_power', 'measure_soc_level'],
      capabilitiesObj: { charging_on: cap(true), charging_state: cap('Charging'), measure_charge_power: cap(4),
        measure_soc_level: cap(55), charging_port_cable: cap('IEC') } },
    { ...HOMEY_DEVICE_FIELDS, id: `${id}-car`, name: id, class: 'car', data, driverId: 'homey:app:com.tesla.car:car',
      capabilitiesObj: { car_state: cap('online'), car_shift_state: cap('P'), measure_car_drive_speed: cap(0) } },
    { ...HOMEY_DEVICE_FIELDS, id: `${id}-location`, name: id, class: 'sensor', data, driverId: 'homey:app:com.tesla.car:location',
      capabilitiesObj: { measure_location_latitude: cap(60), measure_location_longitude: cap(10) } },
  ];
}

function snapshot(device: HomeyDeviceLike): TransportDeviceSnapshot {
  return partialDouble<TransportDeviceSnapshot>({ id: device.id, capabilities: device.capabilities,
    available: true, measuredPowerKw: 4 });
}

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-15T10:00:00Z')); });
afterEach(() => { vi.useRealTimers(); });

test('the generic registry isolates two vehicle sessions and trust recovery', () => {
  const home = partialDouble<HubHomeLocation>({ coordinates: () => ({ latitude: 60, longitude: 10 }) });
  const sessions = new DeviceAdapterSessions(home);
  sessions.setTrustEpoch('connected:1');
  const first = vehicle('first');
  const second = vehicle('second');
  sessions.observeDevices([...first, ...second], Date.now());
  const firstSnapshot = snapshot(first[0]!);
  const secondSnapshot = snapshot(second[0]!);
  expect(sessions.project(firstSnapshot, setup).available).toBe(true);
  expect(sessions.project(secondSnapshot, setup).available).toBe(true);
  sessions.observeCapability('first-location', 'measure_location_latitude', 61);
  expect(sessions.project(firstSnapshot, setup)).toMatchObject({ available: false, measuredPowerKw: 0 });
  expect(sessions.project(secondSnapshot, setup).available).toBe(true);
  sessions.setTrustEpoch('disconnected:2');
  expect(sessions.project(secondSnapshot, setup)).toMatchObject({ available: false, measuredPowerKw: 0 });
  expect(sessions.controlEvents(secondSnapshot, 'measure_charge_power', 4)).toEqual([
    { capabilityId: 'measure_charge_power', value: 0 },
  ]);
});

test('vendor action arguments and installation membership are resolved by the binding owner', () => {
  const car = vehicle('car')[0]!;
  const charger: HomeyDeviceLike = { ...HOMEY_DEVICE_FIELDS, id: 'charger', name: 'Charger', driverId: 'homey:app:com.zaptec:go',
    data: { installationId: 'site' }, capabilities: ['available_installation_current'] };
  const carBinding = getDeviceAdapter(car).currentBindings(car)[0]!;
  const chargerBinding = getDeviceAdapter(charger).currentBindings(charger)[0]!;
  expect(resolveChargingCurrentAction(carBinding, [{ id: 'homey:device:car:charge_current' }], 10).args)
    .toEqual({ current: 10 });
  expect(resolveChargingCurrentAction(chargerBinding, [{ id: 'homey:device:charger:installation_current_control' }], 10).args)
    .toEqual({ current1: 10, current2: 10, current3: 10 });
  // Even a sibling without a supported current-control driver belongs to the installation.
  expect(hasSharedChargingInstallation(chargerBinding, [charger, { ...HOMEY_DEVICE_FIELDS,
    id: 'other', name: 'Other charger', class: 'evcharger', driverId: 'homey:app:com.zaptec:other',
    data: { installationId: 'site' },
  }])).toBe(true);
});

test('an unrelated device retains standard behavior and exposes no integration control bindings', () => {
  const device: HomeyDeviceLike = { ...HOMEY_DEVICE_FIELDS, id: 'heater', name: 'Heater', class: 'heater', capabilities: ['onoff'] };
  const adapter = getDeviceAdapter(device);
  expect(adapter.identity(device)).toBe(device);
  expect(adapter.currentBindings(device)).toEqual([]);
  expect(adapter.nativeCurrentControls).toEqual([]);
});

test('a Futurehome charger reports its sent current limit and only a one-phase installation', () => {
  const charger = (settings: Record<string, unknown>): HomeyDeviceLike => ({ ...HOMEY_DEVICE_FIELDS, id: 'futurehome', name: 'Futurehome',
    class: 'evcharger', driverId: 'homey:app:no.futurehome:ev_charger', settings,
    capabilities: ['evcharger_charging', 'evcharger_charging_state', 'measure_power'] });
  const read = (device: HomeyDeviceLike) => getDeviceAdapter(device)
    .overlay(device, device.capabilities ?? [], {}).capabilityObj.available_installation_current;
  expect(read(charger({ currentLimit: 16 }))).toEqual({ value: 16, setable: false });
  for (const currentLimit of [5, 33, 10.5, '16', null]) expect(read(charger({ currentLimit }))).toBeUndefined();
  expect(getDeviceAdapter(charger({ phases: 'one' })).phaseReport(charger({ phases: 'one' })))
    .toEqual({ kind: 'reported', preset: 'ev_charger_1_phase' });
  // Three phases may be an IT grid, which the three-phase preset does not model.
  expect(getDeviceAdapter(charger({ phases: 'three' })).phaseReport(charger({ phases: 'three' })))
    .toEqual({ kind: 'not_reported' });
});

test('an amina S reads its switch from onoff, its plug state from the EV status and its sent limit', () => {
  type Status = { onoff: boolean; ev_connected: boolean; power_delivered: boolean; charging_paused: boolean };
  const charger = (status: Partial<Status>, settings: Record<string, unknown> = {}): HomeyDeviceLike => ({
    ...HOMEY_DEVICE_FIELDS, id: 'amina', name: 'amina S', class: 'evcharger',
    driverId: 'homey:app:com.aminacharging:amina-s', settings,
    capabilities: ['onoff', 'ev_connected', 'power_delivered', 'charging_paused', 'measure_power'],
    capabilitiesObj: Object.fromEntries(Object.entries(status).map(([id, value]) => [id, { ...cap(value), setable: id === 'onoff' }])),
  });
  const overlay = (device: HomeyDeviceLike) => getDeviceAdapter(device)
    .overlay(device, device.capabilities ?? [], standardDeviceAdapter.observation(device));
  const plugState = (status: Partial<Status>) => overlay(charger(status)).capabilityObj.evcharger_charging_state?.value;
  const connected = { onoff: true, ev_connected: true, power_delivered: false, charging_paused: false };

  expect(plugState({ ...connected, ev_connected: false })).toBe('plugged_out');
  expect(plugState({ ev_connected: false })).toBe('plugged_out');
  expect(plugState({ ...connected, power_delivered: true })).toBe('plugged_in_charging');
  expect(plugState({ ...connected, onoff: false })).toBe('plugged_in_paused');
  expect(plugState({ ...connected, charging_paused: true })).toBe('plugged_in_paused');
  // Connected and enabled, but the car takes nothing.
  expect(plugState(connected)).toBe('plugged_in');
  // A missing status reading leaves the state unread.
  expect(plugState({ onoff: true, ev_connected: true, power_delivered: false })).toBeUndefined();

  const adapted = overlay(charger(connected, { maxCurrent: 16 }));
  expect(adapted).toMatchObject({ kind: 'adapted', binaryTarget: { kind: 'capability', writeCapabilityId: 'onoff',
    observationCapabilityId: 'evcharger_charging' } });
  expect(adapted.capabilities).toEqual(expect.arrayContaining(['evcharger_charging', 'evcharger_charging_state']));
  expect(adapted.capabilityObj.evcharger_charging?.value).toBe(true);
  expect(adapted.capabilityObj.available_installation_current).toEqual({ value: 16, setable: false });
  for (const maxCurrent of [5, 33, 10.5, '16', null]) {
    expect(overlay(charger(connected, { maxCurrent })).capabilityObj.available_installation_current).toBeUndefined();
  }

  // A live report carries the switch and the plug state derived from the device as it now reads.
  expect(getDeviceAdapter(charger(connected)).normalize(
    partialDouble({ controlAdapter: adapted.kind === 'adapted' ? adapted.controlAdapter : undefined }),
    'onoff', false, charger({ ...connected, onoff: false }),
  )).toEqual([
    { capabilityId: 'onoff', value: false },
    { capabilityId: 'evcharger_charging', value: false },
    { capabilityId: 'evcharger_charging_state', value: 'plugged_in_paused' },
  ]);

  const binding = getDeviceAdapter(charger(connected)).currentBindings(charger(connected))[0]!;
  expect(resolveChargingCurrentAction(binding, [{ id: 'homey:app:com.aminacharging:set_charging_current' }], 10).args)
    .toEqual({ device: { id: 'amina' }, max: 10 });
  expect(getDeviceAdapter(charger(connected)).phaseReport(charger(connected, { singlePhase: true })))
    .toEqual({ kind: 'reported', preset: 'ev_charger_1_phase' });
  // Three phases may be an IT grid, which the three-phase preset does not model.
  expect(getDeviceAdapter(charger(connected)).phaseReport(charger(connected, { singlePhase: false })))
    .toEqual({ kind: 'not_reported' });
});

test('a go-e reads its switch from is_allowed, its plug state from the status and its current from current_limit', () => {
  type Status = { is_allowed: boolean; status: string; current_limit: number; num_phases: string };
  const charger = (status: Partial<Status>): HomeyDeviceLike => ({
    ...HOMEY_DEVICE_FIELDS, id: 'goe', name: 'go-e', class: 'evcharger',
    driverId: 'homey:app:com.go-e.charger:go-eCharger_V3',
    capabilities: ['is_allowed', 'is_charging', 'is_connected', 'status', 'current_limit', 'num_phases', 'measure_power'],
    capabilitiesObj: Object.fromEntries(Object.entries(status)
      .map(([id, value]) => [id, { ...cap(value), setable: id === 'is_allowed' || id === 'num_phases' }])),
  });
  const overlay = (device: HomeyDeviceLike) => getDeviceAdapter(device)
    .overlay(device, device.capabilities ?? [], standardDeviceAdapter.observation(device));
  const plugState = (status: Partial<Status>) => overlay(charger(status)).capabilityObj.evcharger_charging_state?.value;
  const waiting = { is_allowed: true, status: 'station_waiting' };

  expect(plugState({ ...waiting, status: 'station_idle' })).toBe('plugged_out');
  expect(plugState({ ...waiting, status: 'car_charging' })).toBe('plugged_in_charging');
  expect(plugState({ ...waiting, is_allowed: false })).toBe('plugged_in_paused');
  expect(plugState({ ...waiting, status: 'car_finished', is_allowed: false })).toBe('plugged_in_paused');
  // Connected and allowed, but the car takes nothing.
  expect(plugState(waiting)).toBe('plugged_in');
  expect(plugState({ ...waiting, status: 'car_finished' })).toBe('plugged_in_finished');
  // An error or an unknown status leaves the state unread.
  expect(plugState({ ...waiting, status: 'station_error' })).toBeUndefined();
  expect(plugState({ status: 'station_waiting' })).toBeUndefined();

  const adapted = overlay(charger({ ...waiting, current_limit: 16 }));
  expect(adapted).toMatchObject({ kind: 'adapted', binaryTarget: { kind: 'capability', writeCapabilityId: 'is_allowed',
    observationCapabilityId: 'evcharger_charging' }, controlAdapter: { activationOrder: 'current_before_start' } });
  expect(adapted.capabilities).toEqual(expect.arrayContaining(['evcharger_charging', 'evcharger_charging_state']));
  expect(adapted.capabilityObj.evcharger_charging?.value).toBe(true);
  expect(adapted.capabilityObj.available_installation_current).toMatchObject({ value: 16, setable: false });
  for (const currentLimit of [5, 33, 10.5]) {
    expect(overlay(charger({ ...waiting, current_limit: currentLimit })).capabilityObj.available_installation_current)
      .toBeUndefined();
  }

  const adapter = getDeviceAdapter(charger(waiting));
  const control = adapted.kind === 'adapted' ? adapted.controlAdapter : undefined;
  expect(adapter.normalize(partialDouble({ controlAdapter: control }), 'is_allowed', false,
    charger({ ...waiting, is_allowed: false }))).toEqual([
    { capabilityId: 'is_allowed', value: false },
    { capabilityId: 'evcharger_charging', value: false },
    { capabilityId: 'evcharger_charging_state', value: 'plugged_in_paused' },
  ]);
  expect(adapter.normalize(partialDouble({ controlAdapter: control }), 'current_limit', 10, charger(waiting))).toEqual([
    { capabilityId: 'current_limit', value: 10 },
    { capabilityId: 'available_installation_current', value: 10 },
  ]);

  const binding = adapter.currentBindings(charger(waiting))[0]!;
  expect(binding).toMatchObject({ current: { kind: 'action_only' }, scope: { kind: 'charger' } });
  expect(resolveChargingCurrentAction(binding, [{ id: 'homey:app:com.go-e.charger:change_current' }], 10).args)
    .toEqual({ device: { id: 'goe' }, action_amps: 10 });
  expect(adapter.phaseReport(charger({ ...waiting, num_phases: '1' })))
    .toEqual({ kind: 'reported', preset: 'ev_charger_1_phase' });
  // Three is the app's default, not a reading, and may be an IT grid.
  expect(adapter.phaseReport(charger({ ...waiting, num_phases: '3' }))).toEqual({ kind: 'not_reported' });
});

test('a Smappee EV Wall reads its switch from the charging mode and writes it as normal or paused', () => {
  type Status = { charging_mode: string; cable_connected: boolean; charging: boolean };
  const charger = (status: Partial<Status>): HomeyDeviceLike => ({
    ...HOMEY_DEVICE_FIELDS, id: 'smappee', name: 'EV Wall', class: 'other',
    driverId: 'homey:app:com.smappee:ev-wall',
    capabilities: ['measure_power', 'measure_power.alwayson', 'cable_connected', 'charging', 'charging_mode'],
    capabilitiesObj: Object.fromEntries(Object.entries(status)
      .map(([id, value]) => [id, { ...cap(value), setable: id === 'charging_mode' }])),
  });
  const overlay = (device: HomeyDeviceLike) => getDeviceAdapter(device)
    .overlay(device, device.capabilities ?? [], standardDeviceAdapter.observation(device));
  const plugState = (status: Partial<Status>) => overlay(charger(status)).capabilityObj.evcharger_charging_state?.value;
  const connected = { charging_mode: 'normal', cable_connected: true, charging: false };

  expect(plugState({ ...connected, cable_connected: false })).toBe('plugged_out');
  expect(plugState({ cable_connected: false })).toBe('plugged_out');
  expect(plugState({ ...connected, charging: true })).toBe('plugged_in_charging');
  expect(plugState({ ...connected, charging_mode: 'paused' })).toBe('plugged_in_paused');
  expect(plugState(connected)).toBe('plugged_in');
  expect(plugState({ ...connected, charging_mode: 'smart' })).toBe('plugged_in');
  expect(plugState({ ...connected, charging_mode: 'eco' })).toBeUndefined();

  const adapted = overlay(charger(connected));
  expect(adapted).toMatchObject({ kind: 'adapted', binaryTarget: { kind: 'capability',
    writeCapabilityId: 'charging_mode', observationCapabilityId: 'evcharger_charging' } });
  expect(adapted.capabilityObj.evcharger_charging?.value).toBe(true);
  expect(overlay(charger({ ...connected, charging_mode: 'smart' })).capabilityObj.evcharger_charging?.value).toBe(true);
  expect(overlay(charger({ ...connected, charging_mode: 'paused' })).capabilityObj.evcharger_charging?.value)
    .toBe(false);

  const adapter = getDeviceAdapter(charger(connected));
  const switchSnapshot = partialDouble<TransportDeviceSnapshot>({
    id: 'smappee', binaryCapabilityId: 'evcharger_charging', binaryWriteCapabilityId: 'charging_mode',
  });
  expect(adapter.switchWrite(switchSnapshot, { capabilityId: 'evcharger_charging', value: false }))
    .toEqual({ kind: 'write', write: { capabilityId: 'charging_mode', value: 'paused' }, readBackAsWritten: false });
  expect(adapter.switchWrite(switchSnapshot, { capabilityId: 'evcharger_charging', value: true }))
    .toEqual({ kind: 'write', write: { capabilityId: 'charging_mode', value: 'normal' }, readBackAsWritten: false });
  const control = adapted.kind === 'adapted' ? adapted.controlAdapter : undefined;
  expect(adapter.normalize(partialDouble({ controlAdapter: control }), 'charging_mode', 'paused',
    charger({ ...connected, charging_mode: 'paused' }))).toEqual([
    { capabilityId: 'charging_mode', value: 'paused' },
    { capabilityId: 'evcharger_charging', value: false },
    { capabilityId: 'evcharger_charging_state', value: 'plugged_in_paused' },
  ]);
  expect(adapter.currentBindings(charger(connected))).toEqual([]);
});

test('a Futurehome limit is dated by the newest read only, and only on a step at that current', () => {
  const session = new FuturehomeChargerSession();
  const charger = (currentLimit: unknown): HomeyDeviceLike => ({ ...HOMEY_DEVICE_FIELDS, id: 'futurehome', name: 'Futurehome',
    class: 'evcharger', driverId: 'homey:app:no.futurehome:ev_charger', settings: { currentLimit } });
  const steppedLoadProfile = { steps: [6, 10, 12, 16].map((amps) => (
    { id: `${amps}a`, planningPowerW: amps * 230, planningCurrentA: amps })) };
  const dateOf = (reportedStepId: string) => session.project(
    partialDouble<TransportDeviceSnapshot>({ id: 'futurehome', reportedStepId, steppedLoadProfile }),
  ).reportedStepObservedAtMs;
  const startMs = Date.now();
  session.observeDevice(charger(16), startMs);
  expect(dateOf('16a')).toBe(startMs);

  // A device update shows the new limit.
  vi.advanceTimersByTime(2000);
  session.observeDevice(charger(10), startMs + 2000);
  expect(dateOf('10a')).toBe(startMs + 2000);
  // A refresh fetched before that update still shows the old one: older
  // evidence, and its parsed 16 A step is not lent the 10 A date.
  vi.advanceTimersByTime(1000);
  session.observeDevice(charger(16), startMs + 1000);
  expect(dateOf('16a')).toBeUndefined();
  // A value the charger cannot hold is no reading.
  session.observeDevice(charger(40), startMs + 3000);
  session.observeDevice(charger(10), startMs + 3000);
  expect(dateOf('10a')).toBe(startMs + 2000);
  // A refresh the session never saw (the live feed was down) parsed 12 A: undated.
  expect(dateOf('12a')).toBeUndefined();
});
