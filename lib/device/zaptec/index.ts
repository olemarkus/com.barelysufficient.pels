import type { DeviceAdapter } from '../deviceAdapter';
import { standardDeviceAdapter } from '../standardDeviceAdapter';
import { applyNativeEvWiringOverlay, normalizeNativeEvCapabilityUpdate,
  buildNativeEvObservationCapabilityObj } from './charging';
import { ZaptecInstallationSession, zaptecInstallationOf } from './session';
import { prepareZaptecTargetPowerReassertion } from './targetPowerReassertion';

export const zaptecAdapter: DeviceAdapter = {
  ...standardDeviceAdapter,
  stepActivationOrder: 'current_before_start',
  matches: (device) => /^homey:app:com\.zaptec:(go|go2|home|pro)$/u.test(device.driverId.trim().toLowerCase()),
  matchesCapabilities: (capabilities) => capabilities.includes('charging_button')
    || capabilities.includes('charge_mode'),
  overlay: applyNativeEvWiringOverlay,
  normalize: normalizeNativeEvCapabilityUpdate,
  prepareTargetPowerReassertion: prepareZaptecTargetPowerReassertion,
  readRules: () => ({
    charging_button: 'boolean',
    charge_mode: 'string',
    'alarm_generic.car_connected': 'boolean',
  }),
  finalizeObservation: (control, _capabilities, values) => control.activationEnabled
    ? buildNativeEvObservationCapabilityObj(values) : values,
  currentBindings: (device) => {
    const match = /^homey:app:com\.zaptec:(go|go2|home|pro)$/u.exec(device.driverId);
    const installationId = device.data.installationId;
    if (!match || !installationId || !device.capabilities.includes('available_installation_current')) return [];
    return [{ deviceId: device.id,
      current: { kind: 'capability', capabilityId: 'available_installation_current',
        writable: device.capabilitiesObj.available_installation_current?.setable === true },
      appUri: 'homey:app:com.zaptec',
      actionId: match[1] === 'go' ? 'installation_current_control' : `${match[1]}_installation_current_control`,
      scope: { kind: 'installation', installationId },
      sharesInstallation: (other) => zaptecInstallationOf(other) === installationId,
      currentArguments: (currentA) => ({ current1: currentA, current2: currentA, current3: currentA }),
    }];
  },
  switchWrite: (snapshot, request, sessions) => {
    if (request.capabilityId === snapshot.binaryCapabilityId && snapshot.canSetControl === false) {
      return { kind: 'none' };
    }
    return standardDeviceAdapter.switchWrite(snapshot, request, sessions);
  },
  recoverSwitchWrite: (snapshot, raw, request, sessions) => {
    if (request.capabilityId === snapshot.binaryCapabilityId) {
      const writeId = snapshot.binaryWriteCapabilityId ?? request.capabilityId;
      const descriptor = raw.capabilitiesObj[writeId];
      if (!raw.capabilities.includes(writeId) || !descriptor || descriptor.setable === false) {
        return { kind: 'none' };
      }
    }
    return zaptecAdapter.switchWrite(snapshot, request, sessions);
  },
  createSession: () => new ZaptecInstallationSession(),
};
