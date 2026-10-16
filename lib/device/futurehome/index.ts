import type { DeviceAdapter } from '../deviceAdapter';
import type { ChargerPhaseReport } from '../chargerPhasePreset';
import type { DeviceCapabilityMap } from '../managerControl';
import type { HomeyDeviceLike } from '../../utils/types';
import { standardDeviceAdapter } from '../standardDeviceAdapter';
import { isFuturehomeCharger, readCurrentLimit } from './identity';
import { FuturehomeChargerSession } from './session';

// Futurehome 1.11.0 (`drivers/ev_charger`): a Zigbee charger with standard EV
// capabilities and no current capability. Its `currentLimit` action writes the
// charger and only then saves the same value to the device's `currentLimit`
// setting, which is also read from the charger at startup. For changes made
// through Homey, that setting is therefore the applied ceiling; a change made
// outside Homey shows only after the vendor app restarts. A changed setting reaches PELS as a device
// update carrying the whole device; the session dates it.
const PHASES_SETTING = 'phases';
const INSTALLATION_CURRENT = 'available_installation_current';

function withAppliedCurrent(device: HomeyDeviceLike, capabilityObj: DeviceCapabilityMap): DeviceCapabilityMap {
  const currentA = readCurrentLimit(device);
  return currentA === undefined
    ? capabilityObj
    : { ...capabilityObj, [INSTALLATION_CURRENT]: { value: currentA, setable: false } };
}

// "Installed phases" says nothing about the grid. Three phases on a Norwegian
// IT grid draw sqrt(3) * 230 W/A, which the three-phase preset does not model,
// so only a one-phase installation is reported.
function resolvePhaseReport(device: HomeyDeviceLike): ChargerPhaseReport {
  return isFuturehomeCharger(device) && device.settings?.[PHASES_SETTING] === 'one'
    ? { kind: 'reported', preset: 'ev_charger_1_phase' }
    : { kind: 'not_reported' };
}

export const futurehomeAdapter: DeviceAdapter = {
  ...standardDeviceAdapter,
  matches: isFuturehomeCharger,
  overlay: (device, capabilities, capabilityObj) => ({
    kind: 'standard', capabilities, capabilityObj: withAppliedCurrent(device, capabilityObj),
  }),
  phaseReport: resolvePhaseReport,
  currentBindings: (device) => isFuturehomeCharger(device) ? [{
    deviceId: device.id,
    current: { kind: 'action_only' },
    appUri: 'homey:app:no.futurehome',
    actionId: 'currentLimit',
    scope: { kind: 'charger' },
    sharesInstallation: () => false,
    currentArguments: (currentA) => ({ value: currentA }),
  }] : [],
  createSession: () => new FuturehomeChargerSession(),
};
