import type { DeviceAdapter, DeviceReadRule, DeviceEvOverlay } from '../deviceAdapter';
import { standardDeviceAdapter } from '../standardDeviceAdapter';
import { isTeslaChargingDevice, teslaDriver } from './identity';
import { teslaChargingCapabilities, normalizeTeslaChargingUpdate,
  hasTeslaChargingStateWithoutEvProjection, isTeslaChargingState } from './charging';
import { TeslaChargingSession } from './session';
import type { HomeyDeviceLike } from '../../utils/types';
import type { DeviceCapabilityMap } from '../managerControl';

const TESLA_MODEL_CAPABILITY_TYPES: Readonly<Record<string, Readonly<Record<string, DeviceReadRule>>>> = {
    battery: {
        charging_on: 'boolean', charging_state: isTeslaChargingState, charging_port_cable: 'string',
        measure_charge_current_max: 'number', measure_charge_current: 'number',
        measure_charge_power: 'number', measure_charge_power_dc: 'number',
    },
    location: {
        measure_location_latitude: 'number', measure_location_longitude: 'number',
    },
    car: {
        car_state: 'string', car_shift_state: 'string', measure_car_drive_speed: 'number',
    },
};
export const teslaAdapter: DeviceAdapter = {
  ...standardDeviceAdapter,
  matches: (device) => teslaDriver(device) !== undefined,
  matchesCapabilities: (capabilities) => capabilities.includes('charging_on'),
  identity: (device) => isTeslaChargingDevice(device)
    ? { ...device, class: 'evcharger', virtualClass: 'evcharger' } : device,
  overlay: chargingOverlay,
  normalize: (_snapshot, capabilityId, value) => normalizeTeslaChargingUpdate(capabilityId, value),
  observation: (device) => teslaChargingCapabilities(device, standardDeviceAdapter.observation(device)),
  readRules: (device) => TESLA_MODEL_CAPABILITY_TYPES[teslaDriver(device) ?? ''] ?? {},
  retainsPlugObservation: hasTeslaChargingStateWithoutEvProjection,
  currentBindings: (device) => isTeslaChargingDevice(device) ? [{
    deviceId: device.id,
    current: { kind: 'capability', capabilityId: 'measure_charge_current_max',
      writable: device.capabilitiesObj?.measure_charge_current_max?.setable === true },
    actionId: 'charge_current', appUri: 'homey:app:com.tesla.car', scope: { kind: 'vehicle' },
    sharesInstallation: () => false,
    currentArguments: (currentA) => ({ current: currentA }),
  }] : [],
  readBackAfterWrite: false,
  createSession: (home) => new TeslaChargingSession(home),
};

function chargingOverlay(
  device: HomeyDeviceLike, capabilities: string[], capabilityObj: DeviceCapabilityMap,
): DeviceEvOverlay {
  if (!isTeslaChargingDevice(device)) return { kind: 'standard', capabilities, capabilityObj };
  const values = teslaChargingCapabilities(device, capabilityObj);
  const derived = ['evcharger_charging', 'evcharger_charging_state', 'measure_power']
    .filter(id => values[id] !== undefined);
  return {
    kind: 'adapted',
    capabilities: [...new Set([...capabilities, ...derived])],
    capabilityObj: values,
    controlAdapter: { kind: 'capability_adapter', activationRequired: false, activationEnabled: true,
      activationOrder: 'current_before_start' },
    binaryTarget: { kind: 'capability', writeCapabilityId: 'charging_on',
      observationCapabilityId: 'evcharger_charging' },
  };
}
