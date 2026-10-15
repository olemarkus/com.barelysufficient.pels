import type { DeviceAdapter, DeviceReadRule } from '../deviceAdapter';
import { standardDeviceAdapter } from '../standardDeviceAdapter';
import { isTeslaChargingDevice } from './identity';
import { teslaChargingCapabilities, normalizeTeslaChargingUpdate,
  hasTeslaChargingStateWithoutEvProjection, isTeslaChargingState } from './charging';
import { TeslaChargingSession } from './session';

const TESLA_MODEL_CAPABILITY_TYPES: Readonly<Record<string, Readonly<Record<string, DeviceReadRule>>>> = {
    'homey:app:com.tesla.car:battery': {
        charging_on: 'boolean', charging_state: isTeslaChargingState, charging_port_cable: 'string',
        measure_charge_current_max: 'number', measure_charge_current: 'number',
        measure_charge_power: 'number', measure_charge_power_dc: 'number',
    },
    'homey:app:com.tesla.car:location': {
        measure_location_latitude: 'number', measure_location_longitude: 'number',
    },
    'homey:app:com.tesla.car:car': {
        car_state: 'string', car_shift_state: 'string', measure_car_drive_speed: 'number',
    },
};
export const teslaAdapter: DeviceAdapter = {
  ...standardDeviceAdapter,
  matches: (device) => device.driverId?.startsWith('homey:app:com.tesla.car:') === true,
  matchesCapabilities: (capabilities) => capabilities.includes('charging_on'),
  identity: (device) => isTeslaChargingDevice(device)
    ? { ...device, class: 'evcharger', virtualClass: 'evcharger' } : device,
  overlay: (device, capabilities, capabilityObj) => isTeslaChargingDevice(device) ? {
    kind: 'adapted',
    capabilities: [...new Set([...capabilities, 'evcharger_charging', 'evcharger_charging_state', 'measure_power'])],
    capabilityObj: teslaChargingCapabilities(device, capabilityObj),
    controlAdapter: { kind: 'capability_adapter', activationRequired: false, activationEnabled: true,
      activationOrder: 'current_before_start' },
    binaryTarget: { kind: 'capability', writeCapabilityId: 'charging_on',
      observationCapabilityId: 'evcharger_charging' },
  } : { kind: 'standard', capabilities, capabilityObj },
  normalize: (_snapshot, capabilityId, value) => normalizeTeslaChargingUpdate(capabilityId, value),
  observation: (device) => teslaChargingCapabilities(device, standardDeviceAdapter.observation(device)),
  readRules: (device) => TESLA_MODEL_CAPABILITY_TYPES[device.driverId ?? ''] ?? {},
  retainsPlugObservation: hasTeslaChargingStateWithoutEvProjection,
  currentBindings: (device) => isTeslaChargingDevice(device) ? [{
    deviceId: device.id, currentCapabilityId: 'measure_charge_current_max',
    currentWritable: device.capabilitiesObj?.measure_charge_current_max?.setable === true,
    actionId: 'charge_current', appUri: 'homey:app:com.tesla.car', scope: { kind: 'vehicle' },
    sharesInstallation: () => false,
    currentArguments: (currentA) => ({ current: currentA }),
  }] : [],
  readBackAfterWrite: false,
  createSession: (home) => new TeslaChargingSession(home),
};
