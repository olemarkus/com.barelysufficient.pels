import { findDeviceReadContractViolation } from '../../lib/device/transport/deviceReadContract';
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

  it('checks a car only on what PELS reads from a car', () => {
    // Shape observed on a production hub: the car integration declares an
    // interior temperature it has never reported.
    const car = (plugState: unknown): HomeyDeviceLike => asRead({
      id: 'car-1',
      name: 'Car',
      class: 'car',
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
