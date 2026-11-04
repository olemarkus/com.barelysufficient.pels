import {
  findDeviceReadContractViolation,
  resolveDeviceRead,
  withholdInvalidModelCapabilities,
  withAcceptedCapabilityReport,
} from '../../lib/device/transport/deviceReadContract';
import type { DeviceCapabilityMap } from '../../lib/device/managerControl';
import { isTargetPowerControlActive } from '../../lib/device/nativeSteppedLoadWiring';
import type { HomeyDeviceLike } from '../../lib/utils/types';

const STAMP = '2026-09-23T10:00:00.000Z';

// The contract's input is an unvalidated SDK payload: its values are whatever
// Homey sent, not the types the model will read them as.
type RawCapabilityEntry = { value?: unknown; lastUpdated?: string | null };
type RawDeviceRead = Omit<HomeyDeviceLike, 'capabilitiesObj'> & {
  capabilitiesObj?: Record<string, RawCapabilityEntry | undefined>;
};
const asRead = (device: RawDeviceRead): HomeyDeviceLike => device as HomeyDeviceLike;
const entry = (value: unknown): RawCapabilityEntry => ({ value, lastUpdated: STAMP });

const HEATER_VALUES: Record<string, RawCapabilityEntry> = {
  onoff: entry(true),
  measure_power: entry(1200),
  meter_power: entry(42.5),
  // Outside the model: a button's value is null by design, and never read.
  'button.reset': entry(null),
};

const heater = (overrides: Partial<RawDeviceRead> = {}): HomeyDeviceLike => asRead({
  id: 'heater-1',
  name: 'Heater',
  class: 'heater',
  capabilities: ['onoff', 'measure_power', 'meter_power', 'button.reset'],
  capabilitiesObj: HEATER_VALUES,
  ...overrides,
});

const zaptec = (capabilitiesObj: Record<string, RawCapabilityEntry>): HomeyDeviceLike => asRead({
  id: 'zaptec-1',
  name: 'Zaptec Go',
  class: 'evcharger',
  driverId: 'homey:app:com.zaptec:go',
  capabilities: ['charging_button', 'charge_mode', 'alarm_generic.car_connected', 'measure_power'],
  capabilitiesObj: { measure_power: entry(0), ...capabilitiesObj },
});

describe('device-read contract', () => {
  it('reads an Easee charger for its current, so one Homey never set is not yet readable', () => {
    const easee = (current: unknown): HomeyDeviceLike => asRead({
      id: 'easee-1',
      name: 'Elbillader',
      class: 'evcharger',
      driverId: 'homey:app:no.easee:charger',
      ownerUri: 'homey:app:no.easee',
      capabilities: ['evcharger_charging', 'evcharger_charging_state', 'target_charger_current', 'measure_power'],
      capabilitiesObj: {
        evcharger_charging: entry(false),
        evcharger_charging_state: entry('plugged_in_paused'),
        target_charger_current: entry(current),
        measure_power: entry(0),
      },
    });

    expect(findDeviceReadContractViolation(easee(6))).toBeNull();
    expect(findDeviceReadContractViolation(easee(null)))
      .toEqual({ reason: 'unexpected_value', capabilityId: 'target_charger_current' });
  });

  it('reads a battery whose target_power Homey never set, but not a stepped load', () => {
    const battery = (targetPower: unknown): HomeyDeviceLike => asRead({
      id: 'battery-1',
      name: 'Marstek Venus',
      class: 'battery',
      capabilities: ['measure_battery', 'measure_power', 'target_power', 'target_power_mode'],
      capabilitiesObj: {
        measure_battery: entry(55),
        measure_power: entry(-2000),
        target_power: entry(targetPower),
        target_power_mode: entry(null),
      },
    });
    expect(findDeviceReadContractViolation(battery(null))).toBeNull();
    expect(findDeviceReadContractViolation(heater({
      capabilities: ['onoff', 'measure_power', 'meter_power', 'target_power'],
      capabilitiesObj: { ...HEATER_VALUES, target_power: entry(null) },
    }))).toEqual({ reason: 'unexpected_value', capabilityId: 'target_power' });
  });

  it('reads a solar panel whose target_power Homey never set', () => {
    expect(findDeviceReadContractViolation(asRead({
      id: 'pv-1',
      name: 'Inverter',
      class: 'solarpanel',
      capabilities: ['measure_power', 'target_power'],
      capabilitiesObj: { measure_power: entry(3200), target_power: entry(null) },
    }))).toBeNull();
  });

  it('accepts a read that carries a value of the model type for every declared model capability', () => {
    expect(findDeviceReadContractViolation(heater())).toBeNull();
  });

  it('ignores a read without its capability list or its values', () => {
    expect(findDeviceReadContractViolation(heater({ capabilities: undefined })))
      .toEqual({ reason: 'missing_capability_list' });
    expect(findDeviceReadContractViolation(heater({ capabilitiesObj: undefined })))
      .toEqual({ reason: 'missing_capability_values' });
  });

  it('identifies a missing declared model capability', () => {
    const { meter_power: _omitted, ...partial } = HEATER_VALUES;
    expect(findDeviceReadContractViolation(heater({ capabilitiesObj: partial })))
      .toEqual({ reason: 'missing_capability_entry', capabilityId: 'meter_power' });
  });

  it('identifies a null or wrong-type field', () => {
    const withNull = heater({ capabilitiesObj: { ...HEATER_VALUES, onoff: entry(null) } });
    expect(findDeviceReadContractViolation(withNull)).toEqual({ reason: 'unexpected_value', capabilityId: 'onoff' });
    const withString = heater({ capabilitiesObj: { ...HEATER_VALUES, measure_power: entry('1200') } });
    expect(findDeviceReadContractViolation(withString))
      .toEqual({ reason: 'unexpected_value', capabilityId: 'measure_power' });
  });

  it('identifies an undated field', () => {
    const unstamped = heater({ capabilitiesObj: { ...HEATER_VALUES, measure_power: { value: 1200 } } });
    expect(findDeviceReadContractViolation(unstamped))
      .toEqual({ reason: 'missing_stamp', capabilityId: 'measure_power' });
    const notATime = heater({ capabilitiesObj: { ...HEATER_VALUES, onoff: { value: true, lastUpdated: 'soon' } } });
    expect(findDeviceReadContractViolation(notATime)).toEqual({ reason: 'missing_stamp', capabilityId: 'onoff' });
    // A button outside the model is never read, stamped or not.
    const unstampedButton = heater({ capabilitiesObj: { ...HEATER_VALUES, 'button.reset': { value: null } } });
    expect(findDeviceReadContractViolation(unstampedButton)).toBeNull();
  });

  it('requires a native plug state to be a member of the Homey enum', () => {
    const charger = (state: unknown): HomeyDeviceLike => asRead({
      id: 'easee-1',
      name: 'Easee',
      class: 'evcharger',
      capabilities: ['evcharger_charging', 'evcharger_charging_state'],
      capabilitiesObj: { evcharger_charging: entry(false), evcharger_charging_state: entry(state) },
    });
    expect(findDeviceReadContractViolation(charger('plugged_in_paused'))).toBeNull();
    expect(findDeviceReadContractViolation(charger('charging_somehow')))
      .toEqual({ reason: 'unexpected_value', capabilityId: 'evcharger_charging_state' });
  });

  it.each(['car', 'vehicle'])('checks a %s only on what PELS reads from a car', (deviceClass) => {
    // Shape observed on a production hub: the car integration declares an
    // interior temperature it has never reported.
    const car = (plugState: unknown): HomeyDeviceLike => asRead({
      id: 'car-1',
      name: 'Car',
      class: deviceClass,
      capabilities: ['measure_battery', 'ev_charging_state', 'target_temperature', 'measure_temperature'],
      capabilitiesObj: {
        measure_battery: entry(37),
        ev_charging_state: entry(plugState),
        target_temperature: entry(22),
        measure_temperature: { value: null, lastUpdated: null },
      },
    });
    expect(findDeviceReadContractViolation(car('plugged_in'))).toBeNull();
    expect(findDeviceReadContractViolation(car('parked')))
      .toEqual({ reason: 'unexpected_value', capabilityId: 'ev_charging_state' });
    const missingStamp = {
      ...car('plugged_in'),
      capabilitiesObj: { ...car('plugged_in').capabilitiesObj, measure_battery: { value: 37 } },
    };
    expect(findDeviceReadContractViolation(missingStamp))
      .toEqual({ reason: 'missing_stamp', capabilityId: 'measure_battery' });
  });

  it('reads temperature only from a device with both the measurement and the target', () => {
    // A cooktop observed on a production hub: an internal temperature it has
    // never reported, and no target — PELS never reads it.
    const loneTemperature = asRead({
      id: 'plug-1',
      name: 'Plug',
      class: 'socket',
      capabilities: ['onoff', 'measure_power', 'measure_temperature'],
      capabilitiesObj: {
        onoff: entry(true),
        measure_power: entry(0),
        measure_temperature: { value: null, lastUpdated: null },
      },
    });
    expect(findDeviceReadContractViolation(loneTemperature)).toBeNull();
    const thermostat = asRead({
      id: 'thermostat-1',
      name: 'Thermostat',
      class: 'thermostat',
      capabilities: ['measure_power', 'measure_temperature', 'target_temperature'],
      capabilitiesObj: {
        measure_power: entry(0),
        measure_temperature: { value: null, lastUpdated: null },
        target_temperature: entry(21),
      },
    });
    expect(findDeviceReadContractViolation(thermostat))
      .toEqual({ reason: 'unexpected_value', capabilityId: 'measure_temperature' });
  });

  it('reads state of charge only from a charger or a home battery', () => {
    const trv = asRead({
      id: 'trv-1',
      name: 'Radiator valve',
      class: 'thermostat',
      capabilities: ['measure_temperature', 'target_temperature', 'measure_battery'],
      capabilitiesObj: {
        measure_temperature: entry(20),
        target_temperature: entry(21),
        measure_battery: { value: null, lastUpdated: null },
      },
    });
    expect(findDeviceReadContractViolation(trv)).toBeNull();
  });

  it('checks nothing on a class PELS does not admit', () => {
    // A camera observed on a production hub: it declares `onoff` and has
    // never reported it. PELS never parses a camera.
    const camera = asRead({
      id: 'camera-1',
      name: 'Camera',
      class: 'camera',
      capabilities: ['onoff', 'measure_battery'],
      capabilitiesObj: { onoff: { value: null, lastUpdated: null }, measure_battery: entry(33) },
    });
    expect(findDeviceReadContractViolation(camera)).toBeNull();
  });

  it('validates a converted charger on the model the conversion produces', () => {
    // Zaptec reports vendor capabilities; the model's plug state is converted
    // from them first, and it is the converted state that must conform.
    expect(findDeviceReadContractViolation(zaptec({
      charging_button: entry(false),
      charge_mode: entry('Connected_Requesting'),
      'alarm_generic.car_connected': entry(true),
    }))).toBeNull();
    // Nothing to convert a plug state from: the converted model has none.
    expect(findDeviceReadContractViolation(zaptec({
      charging_button: entry(false),
      charge_mode: entry(null),
      'alarm_generic.car_connected': entry(null),
    }))).toEqual({ reason: 'unexpected_value', capabilityId: 'charge_mode' });
  });
});


describe('Tesla home-session read contract', () => {
  it.each([
    ['battery', 'charging_port_cable', 'IEC'],
    ['battery', 'measure_charge_current_max', 16],
    ['battery', 'measure_charge_current', 6],
    ['battery', 'measure_charge_power_dc', 0],
    ['location', 'measure_location_latitude', 60],
    ['location', 'measure_location_longitude', 10],
    ['car', 'car_state', 'online'],
    ['car', 'car_shift_state', 'P'],
    ['car', 'measure_car_drive_speed', 0],
  ] as const)('requires typed dated %s %s evidence before accepting a device read', (driver, capabilityId, value) => {
    const device: RawDeviceRead = {
      id: 'tesla', name: 'Tesla', class: driver === 'car' ? 'car' : 'sensor',
      driverId: `homey:app:com.tesla.car:${driver}`,
      capabilities: [capabilityId], capabilitiesObj: { [capabilityId]: entry(value) },
    };
    expect(findDeviceReadContractViolation(asRead(device))).toBeNull();
    device.capabilitiesObj = { [capabilityId]: { value } };
    expect(findDeviceReadContractViolation(asRead(device))).toEqual({ reason: 'missing_stamp', capabilityId });
    device.capabilitiesObj = { [capabilityId]: entry(null) };
    expect(findDeviceReadContractViolation(asRead(device))).toEqual({ reason: 'unexpected_value', capabilityId });
  });
});


describe('Tesla vendor state without an EV equivalent', () => {
  const tesla = (state: unknown): HomeyDeviceLike => asRead({
    id: 'tesla', name: 'Tesla battery', class: 'sensor', driverId: 'homey:app:com.tesla.car:battery',
    capabilities: ['charging_on', 'charging_state', 'measure_charge_power', 'measure_soc_level'],
    capabilitiesObj: { charging_on: entry(false), charging_state: entry(state),
      measure_charge_power: entry(0), measure_soc_level: entry(55) },
  });
  it.each(['Calibrating', 'NoPower', 'Unknown'])('accepts a complete known %s vendor read', (state) => {
    expect(findDeviceReadContractViolation(tesla(state))).toBeNull();
  });
  it.each(['not-a-vendor-state', null, 12])('rejects malformed vendor state %s', (state) => {
    expect(findDeviceReadContractViolation(tesla(state))).toEqual({ reason: 'unexpected_value', capabilityId: 'charging_state' });
  });
  it('identifies an unrelated malformed field in an Unknown read', () => {
    const device = tesla('Unknown');
    delete device.capabilitiesObj!.measure_soc_level;
    expect(findDeviceReadContractViolation(device)).toEqual({ reason: 'missing_capability_entry', capabilityId: 'measure_soc_level' });
  });
});


describe('independent capability resolution', () => {
  const emitter = () => ({ warn: vi.fn(), info: vi.fn() });

  it.each([
    ['null', entry(null)],
    ['wrong type', entry('1200')],
    ['nonfinite', entry(Infinity)],
    ['missing date', { value: 1200 }],
    ['invalid date', { value: 1200, lastUpdated: 'soon' }],
    ['missing entry', undefined],
  ] as const)('withholds only a %s field on the first read', (_label, invalid) => {
    const read = heater({ capabilitiesObj: { ...HEATER_VALUES, measure_power: invalid } });
    const said = emitter();
    const resolved = resolveDeviceRead({}, read, 'device_fetch', said);
    expect(resolved?.capabilities).toEqual(['onoff', 'meter_power', 'button.reset']);
    expect(resolved?.capabilitiesObj).not.toHaveProperty('measure_power');
    expect(resolved?.capabilitiesObj?.onoff).toEqual(entry(true));
    expect(resolved?.capabilitiesObj?.meter_power).toEqual(entry(42.5));
    expect(said.warn).not.toHaveBeenCalled();
    expect(said.info).toHaveBeenCalledWith(expect.objectContaining({
      event: 'device_capabilities_withheld', capabilityIds: ['measure_power'],
      withheldCapabilityIds: ['measure_power'], retainedCapabilityIds: [],
    }));
  });

  it.each([
    entry(null), entry('1200'), entry(NaN), { value: 1200 }, undefined,
  ])('keeps the rejected field at its last accepted date while valid siblings advance', (invalid) => {
    const read = heater({ capabilitiesObj: {
      ...HEATER_VALUES, measure_power: invalid,
      onoff: { value: false, lastUpdated: '2026-09-23T10:10:00.000Z' },
    } });
    const resolved = withholdInvalidModelCapabilities(read, heater());
    expect(resolved.device.capabilitiesObj?.measure_power).toEqual(entry(1200));
    expect(resolved.device.capabilitiesObj?.onoff).toEqual({ value: false, lastUpdated: '2026-09-23T10:10:00.000Z' });
    expect(resolved.retainedCapabilityIds).toEqual(['measure_power']);
    expect(resolved.withheldCapabilityIds).toEqual([]);
  });

  it.each([
    ['thermostat_mode', '   ', 'cool', 'thermostat'],
    ['target_power', -1, 2000, 'heater'],
    ['measure_battery', 101, 45, 'evcharger'],
  ] as const)('does not cache a rejected realtime %s as an accepted field', (capabilityId, invalid, previous, deviceClass) => {
    const device = heater({
      class: deviceClass,
      capabilities: ['onoff', 'measure_temperature', 'target_temperature', capabilityId],
      capabilitiesObj: { onoff: entry(true), measure_temperature: entry(20), target_temperature: entry(21),
        [capabilityId]: entry(previous) },
    });
    expect(withAcceptedCapabilityReport(device, capabilityId, invalid, Date.parse(STAMP) + 60_000)).toBe(device);
    const valid = withAcceptedCapabilityReport(device, capabilityId, previous, Date.parse(STAMP) + 60_000);
    expect(valid.capabilitiesObj?.[capabilityId]).toEqual({ value: previous, lastUpdated: Date.parse(STAMP) + 60_000 });
  });

  it('does not retain an earlier invalid field or mutate either input', () => {
    const previous = heater({ capabilitiesObj: { ...HEATER_VALUES, measure_power: entry('1200') } });
    const read = heater({ capabilitiesObj: { ...HEATER_VALUES, measure_power: entry(null) } });
    expect(withholdInvalidModelCapabilities(read, previous).device.capabilitiesObj).not.toHaveProperty('measure_power');
    expect(previous.capabilitiesObj?.measure_power?.value).toBe('1200');
    expect(read.capabilitiesObj?.measure_power?.value).toBeNull();
  });

  it('withholds multiple malformed fields without hiding valid siblings', () => {
    const read = asRead({
      id: 'thermostat', name: 'Thermostat', class: 'thermostat',
      capabilities: ['onoff', 'measure_temperature', 'target_temperature', 'measure_power'],
      capabilitiesObj: {
        onoff: entry(true), measure_temperature: entry(null), target_temperature: entry('21'), measure_power: entry(900),
      },
    });
    const resolved = resolveDeviceRead({}, read, 'device_fetch', emitter());
    expect(resolved?.capabilities).toEqual(['onoff', 'measure_temperature', 'target_temperature', 'measure_power']);
    expect(resolved?.capabilitiesObj?.measure_power).toEqual(entry(900));
  });

  it('logs recovery and deduplicates an unchanged rejected field', () => {
    const owner = {};
    const said = emitter();
    const bad = heater({ capabilitiesObj: { ...HEATER_VALUES, measure_power: entry(null) } });
    resolveDeviceRead(owner, bad, 'device_update', said);
    resolveDeviceRead(owner, bad, 'device_update', said);
    expect(said.info).toHaveBeenCalledTimes(1);
    expect(resolveDeviceRead(owner, heater(), 'device_update', said)).toBeDefined();
    expect(said.info).toHaveBeenLastCalledWith(expect.objectContaining({ event: 'device_read_conforming_again' }));
  });

  it.each([undefined, null])('ignores only an unreadable structural envelope: %s values', (values) => {
    const said = emitter();
    const device = asRead({ ...heater(), capabilitiesObj: values as undefined });
    expect(resolveDeviceRead({}, device, 'device_fetch', said)).toBeNull();
    expect(said.warn).toHaveBeenCalledWith(expect.objectContaining({
      event: 'device_read_ignored', reason: 'missing_capability_values',
    }));
  });

  it.each([null, 'true', undefined])('never falls back to a charger disabling switch after rejecting charging=%s', (value) => {
    const charger = asRead({
      id: 'charger', name: 'Charger', class: 'evcharger',
      capabilities: ['onoff', 'evcharger_charging', 'evcharger_charging_state', 'measure_power'],
      capabilitiesObj: { onoff: entry(true), evcharger_charging: entry(value),
        evcharger_charging_state: entry('plugged_in_charging'), measure_power: entry(7200) },
    });
    const resolved = withholdInvalidModelCapabilities(charger);
    expect(resolved.device.capabilities).toEqual(['evcharger_charging', 'evcharger_charging_state', 'measure_power']);
    expect(resolved.device.capabilitiesObj?.evcharger_charging).toEqual({});
    expect(resolved.withheldCapabilityIds).toEqual(['evcharger_charging', 'onoff']);
  });

  it('does not grant native watt control when its mode is malformed, while keeping telemetry', () => {
    const device = heater({
      capabilities: ['onoff', 'measure_power', 'target_power', 'target_power_mode'],
      capabilitiesObj: { ...HEATER_VALUES, target_power: entry(2000), target_power_mode: entry('invalid') },
    });
    const resolved = withholdInvalidModelCapabilities(device);
    expect(resolved.device.capabilities).toEqual(['onoff', 'measure_power', 'target_power', 'target_power_mode']);
    expect(resolved.device.capabilitiesObj?.measure_power).toEqual(entry(1200));
    expect(resolved.device.capabilitiesObj?.target_power_mode).not.toHaveProperty('value');
    expect(isTargetPowerControlActive(resolved.device.capabilitiesObj as DeviceCapabilityMap, resolved.device.capabilities!)).toBe(false);
    expect(resolved.withheldCapabilityIds).toEqual(['target_power_mode']);
  });

  it('accepts a Toshiba custom power mode outside native watt control', () => {
    const device = heater({
      class: 'airconditioning', driverUri: 'homey:app:com.toshiba', driverId: 'ac',
      capabilities: ['onoff', 'measure_temperature', 'target_temperature', 'meter_power', 'target_power_mode'],
      capabilitiesObj: { onoff: entry(true), measure_temperature: entry(21), target_temperature: entry(22),
        meter_power: entry(42.5), target_power_mode: entry('Power 100%') },
    });
    expect(resolveDeviceRead({}, device, 'device_fetch', emitter())).toBe(device);
    expect(findDeviceReadContractViolation(device)).toBeNull();
  });

  it('isolates invalid vendor source fields too', () => {
    const tesla = asRead({
      id: 'tesla', name: 'Tesla battery', class: 'sensor', driverId: 'homey:app:com.tesla.car:battery',
      capabilities: ['charging_on', 'charging_state', 'measure_charge_power', 'measure_soc_level'],
      capabilitiesObj: { charging_on: entry(false), charging_state: entry(null),
        measure_charge_power: entry(0), measure_soc_level: entry(55) },
    });
    const resolved = resolveDeviceRead({}, tesla, 'device_fetch', emitter());
    expect(resolved?.capabilitiesObj).not.toHaveProperty('charging_state');
    expect(resolved?.capabilitiesObj?.measure_soc_level).toEqual(entry(55));
    expect(resolved?.capabilitiesObj?.charging_on).toEqual(entry(false));
  });
});
