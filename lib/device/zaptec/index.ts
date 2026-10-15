import type { DeviceAdapter } from '../deviceAdapter';
import { standardDeviceAdapter } from '../standardDeviceAdapter';
import { applyNativeEvWiringOverlay, normalizeNativeEvCapabilityUpdate,
  buildNativeEvObservationCapabilityObj } from './charging';

export const zaptecAdapter: DeviceAdapter = {
  ...standardDeviceAdapter,
  matches: (device) => /^homey:app:com\.zaptec:(go|go2|home|pro)$/u.test(device.driverId?.trim().toLowerCase() ?? ''),
  matchesCapabilities: (capabilities) => capabilities.includes('charging_button')
    || capabilities.includes('charge_mode'),
  overlay: applyNativeEvWiringOverlay,
  normalize: normalizeNativeEvCapabilityUpdate,
  finalizeObservation: (control, _capabilities, values) => control.activationEnabled
    ? buildNativeEvObservationCapabilityObj(values) : values,
  currentBindings: (device) => {
    const match = /^homey:app:com\.zaptec:(go|go2|home|pro)$/u.exec(device.driverId ?? '');
    const installationId = device.data?.installationId;
    if (!match || !installationId || !device.capabilities?.includes('available_installation_current')) return [];
    return [{ deviceId: device.id, currentCapabilityId: 'available_installation_current',
      currentWritable: device.capabilitiesObj?.available_installation_current?.setable === true,
      appUri: 'homey:app:com.zaptec',
      actionId: match[1] === 'go' ? 'installation_current_control' : `${match[1]}_installation_current_control`,
      scope: { kind: 'installation', installationId },
      sharesInstallation: (other) => other.driverId?.startsWith('homey:app:com.zaptec:') === true
        && other.data?.installationId === installationId,
      currentArguments: (currentA) => ({ current1: currentA, current2: currentA, current3: currentA }),
    }];
  },
};
