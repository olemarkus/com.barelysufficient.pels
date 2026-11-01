import type { HomeyDeviceLike } from '../../lib/utils/types';
import { homeyDevice, setable } from './homeyDevicePayload';

/**
 * com.zaptec 1.12.0's native EV surface, with runtime options for a 32 A IT
 * three-phase installation. The app replaces the broader manifest range with
 * these installation-specific options; PELS receives watts, not a phase preset.
 */
export function buildZaptecTargetPowerDevice(overrides: Partial<HomeyDeviceLike> = {}): HomeyDeviceLike {
  const device = homeyDevice({
    id: 'zaptec-target-power', name: 'Zaptec Go 2', class: 'evcharger',
    driverId: 'homey:app:com.zaptec:go2', ownerUri: 'homey:app:com.zaptec',
    data: { id: 'zaptec-target-power', installationId: 'zaptec-installation' },
    available: true, ready: true,
  }, {
    'meter_power.current_session': 0,
    meter_power: 100,
    'meter_power.last_session': 10,
    measure_power: 0,
    evcharger_charging: setable(false),
    cable_permanent_lock: setable(false),
    evcharger_charging_state: 'plugged_in_paused',
    'alarm_generic.car_connected': true,
    available_installation_current: { value: 16, setable: false },
    target_power: {
      value: 0, setable: true, min: 0, max: 12747, step: 230, excludeMin: 0, excludeMax: 2391,
    },
    target_power_mode: setable('device'),
    'measure_current.phase1': 0,
    'measure_current.phase2': 0,
    'measure_current.phase3': 0,
    'measure_voltage.phase1': 230,
    'measure_voltage.phase2': 230,
    'measure_voltage.phase3': 230,
    measure_humidity: 40,
    measure_temperature: 20,
    'meter_power.signed_meter_value': 100,
    measure_signal_strength: 90,
    communication_method: 'WiFi',
    charging_mode: 'Default',
  }, new Date().toISOString());
  return {
    ...device, ...overrides,
    capabilitiesObj: { ...device.capabilitiesObj, ...overrides.capabilitiesObj },
  };
}
