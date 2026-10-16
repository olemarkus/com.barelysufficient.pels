import {
  findDeviceReadContractViolation,
  resolveDeviceRead,
  withholdNullModelCapabilities,
} from '../../lib/device/transport/deviceReadContract';
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

  it('ignores a read that omits a declared model capability, never merging what it did carry', () => {
    const { meter_power: _omitted, ...partial } = HEATER_VALUES;
    expect(findDeviceReadContractViolation(heater({ capabilitiesObj: partial })))
      .toEqual({ reason: 'missing_capability_entry', capabilityId: 'meter_power' });
  });

  it('ignores a read whose model value is null or of the wrong type', () => {
    const withNull = heater({ capabilitiesObj: { ...HEATER_VALUES, onoff: entry(null) } });
    expect(findDeviceReadContractViolation(withNull)).toEqual({ reason: 'unexpected_value', capabilityId: 'onoff' });
    const withString = heater({ capabilitiesObj: { ...HEATER_VALUES, measure_power: entry('1200') } });
    expect(findDeviceReadContractViolation(withString))
      .toEqual({ reason: 'unexpected_value', capabilityId: 'measure_power' });
  });

  it('ignores a read whose model value carries no stamp Homey observed it at', () => {
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
    }))).toEqual({ reason: 'unexpected_value', capabilityId: 'evcharger_charging_state' });
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
  it('still rejects an otherwise malformed Unknown read as a whole', () => {
    const device = tesla('Unknown');
    delete device.capabilitiesObj!.measure_soc_level;
    expect(findDeviceReadContractViolation(device)).toEqual({ reason: 'missing_capability_entry', capabilityId: 'measure_soc_level' });
  });
});


describe('a null model capability (owner ruling 2026-10-16)', () => {
  const emitter = () => ({ warn: vi.fn(), info: vi.fn() });

  it('withholds a null capability, leaving the rest of the read', () => {
    const read = heater({ capabilitiesObj: { ...HEATER_VALUES, meter_power: entry(null) } });
    const resolved = withholdNullModelCapabilities(read);
    expect(resolved.withheldCapabilityIds).toEqual(['meter_power']);
    expect(resolved.device.capabilities).toEqual(['onoff', 'measure_power', 'button.reset']);
    expect(resolved.device.capabilitiesObj).not.toHaveProperty('meter_power');
    expect(resolved.device.capabilitiesObj?.measure_power).toEqual(entry(1200));
    expect(findDeviceReadContractViolation(resolved.device)).toBeNull();
  });

  it('withholds a null capability even after it reported a value: nothing stands in for it', () => {
    const read = heater({ capabilitiesObj: { ...HEATER_VALUES, onoff: entry(null) } });
    const said = emitter();
    const resolved = resolveDeviceRead({}, read, 'device_update', said);
    expect(resolved?.capabilities).toEqual(['measure_power', 'meter_power', 'button.reset']);
    expect(resolved?.capabilitiesObj).not.toHaveProperty('onoff');
    expect(said.info).toHaveBeenCalledWith(expect.objectContaining({
      event: 'device_capabilities_withheld', reason: 'null_value', capabilityIds: ['onoff'],
    }));
  });

  it('says the capability is back once a read reports it again', () => {
    const owner = {};
    const said = emitter();
    resolveDeviceRead(owner, heater({ capabilitiesObj: { ...HEATER_VALUES, onoff: entry(null) } }), 'device_update', said);
    expect(resolveDeviceRead(owner, heater(), 'device_update', said)?.capabilitiesObj?.onoff).toEqual(entry(true));
    expect(said.info).toHaveBeenLastCalledWith(expect.objectContaining({ event: 'device_read_conforming_again' }));
  });

  it('leaves a value of the wrong type to the contract', () => {
    const read = heater({ capabilitiesObj: { ...HEATER_VALUES, measure_power: entry('1200') } });
    const resolved = withholdNullModelCapabilities(read);
    expect(resolved.device).toBe(read);
    expect(findDeviceReadContractViolation(resolved.device))
      .toEqual({ reason: 'unexpected_value', capabilityId: 'measure_power' });
  });

  it('leaves a vendor device an adapter converts all-or-nothing', () => {
    const zaptecRead = zaptec({
      charging_button: entry(false),
      charge_mode: entry('Connected_Requesting'),
      'alarm_generic.car_connected': entry(true),
      measure_power: entry(null),
    });
    expect(withholdNullModelCapabilities(zaptecRead).device).toBe(zaptecRead);
  });

  it('leaves vendor evidence an adapter reads all-or-nothing', () => {
    const tesla = asRead({
      id: 'tesla', name: 'Tesla battery', class: 'sensor', driverId: 'homey:app:com.tesla.car:battery',
      capabilities: ['charging_on', 'charging_state', 'measure_charge_power', 'measure_soc_level'],
      capabilitiesObj: { charging_on: entry(false), charging_state: entry(null),
        measure_charge_power: entry(0), measure_soc_level: entry(55) },
    });
    expect(withholdNullModelCapabilities(tesla).device).toBe(tesla);
    expect(resolveDeviceRead({}, tesla, 'device_fetch', emitter())).toBeNull();
  });

  it('gives a charger no on/off handle while evcharger_charging is null, never falling back to onoff', () => {
    const charger = (charging: unknown): HomeyDeviceLike => asRead({
      id: 'charger-1', name: 'Charger', class: 'evcharger',
      capabilities: ['onoff', 'evcharger_charging', 'evcharger_charging_state', 'measure_power'],
      capabilitiesObj: {
        onoff: entry(true), evcharger_charging: entry(charging),
        evcharger_charging_state: entry('plugged_in_charging'), measure_power: entry(7200),
      },
    });
    expect(withholdNullModelCapabilities(charger(null)).withheldCapabilityIds)
      .toEqual(['evcharger_charging', 'onoff']);
    expect(withholdNullModelCapabilities(charger(true)).withheldCapabilityIds).toEqual([]);
    // Not a charger: a null onoff partner is not implied anywhere else.
    expect(withholdNullModelCapabilities(heater({ capabilitiesObj: { ...HEATER_VALUES, meter_power: entry(null) } }))
      .withheldCapabilityIds).toEqual(['meter_power']);
  });

  const thermostat = (values: Record<string, RawCapabilityEntry>): HomeyDeviceLike => asRead({
    id: 'thermostat-1', name: 'Thermostat', class: 'thermostat',
    capabilities: ['onoff', 'thermostat_mode', 'target_temperature', 'measure_temperature'],
    capabilitiesObj: values,
  });

  it('reads a thermostat without its temperature facet while a member is null', () => {
    const read = thermostat({
      onoff: entry(true), thermostat_mode: entry('heat'), target_temperature: entry(21), measure_temperature: entry(null),
    });
    const said = emitter();
    const resolved = resolveDeviceRead({}, read, 'device_fetch', said);
    expect(resolved?.capabilities).toEqual(['onoff', 'thermostat_mode', 'target_temperature']);
    expect(said.info).toHaveBeenCalledWith(expect.objectContaining({
      event: 'device_capabilities_withheld', reason: 'null_value', capabilityIds: ['measure_temperature'],
    }));
  });

  it('still checks the other members against the model as declared', () => {
    const read = thermostat({
      onoff: entry(true), thermostat_mode: entry('heat'), target_temperature: entry('21'), measure_temperature: entry(null),
    });
    const said = emitter();
    expect(resolveDeviceRead({}, read, 'device_fetch', said)).toBeNull();
    expect(said.warn).toHaveBeenCalledWith(expect.objectContaining({
      event: 'device_read_ignored', reason: 'unexpected_value', capabilityId: 'target_temperature',
    }));
  });
});
