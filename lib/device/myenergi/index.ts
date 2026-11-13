/**
 * The community myenergi app's Zappi (`net.biseth.myenergi`, `zappi` driver,
 * cloud) at the SDK seam. See `notes/native-wiring/zappi.md`.
 *
 * A Zappi has no current a Homey app can set: myenergi's API offers charge
 * modes. PELS switches it on and off and nothing more. A write to the app's
 * `onoff` or `evcharger_charging` does the same thing (charge mode Off, or the
 * owner's last mode), but the app publishes them differently: `onoff` as the
 * charge mode (on unless Off), `evcharger_charging` as "a car is drawing now",
 * which a full car, a car waiting to start, or an Eco mode waiting for solar
 * never is. So the switch is the charge mode: PELS writes `onoff` and reads
 * the charging switch from it.
 */
import type { DeviceAdapter, DeviceEvOverlay } from '../deviceAdapter';
import { whileBuiltInControlEnabled } from '../deviceAdapter';
import type { DeviceCapabilityMap } from '../managerControl';
import type { HomeyDeviceLike } from '../../utils/types';
import { standardDeviceAdapter } from '../standardDeviceAdapter';

const DRIVER_IDS = new Set(['homey:app:net.biseth.myenergi:zappi', 'net.biseth.myenergi:zappi']);
/** Declared by every `zappi` device and by no other driver PELS knows. */
const SIGNATURE_CAPABILITY = 'zappi_boost_mode';

function isZappi(device: HomeyDeviceLike): boolean {
  return DRIVER_IDS.has(device.driverId.trim().toLowerCase());
}

/** The charging switch read from the charge mode, dated by it; the app's own switch otherwise stays. */
function withModeSwitch(values: DeviceCapabilityMap): DeviceCapabilityMap {
  const mode = values.onoff;
  const charging = values.evcharger_charging;
  if (charging === undefined || typeof mode?.value !== 'boolean') return values;
  return { ...values, evcharger_charging: { ...charging, value: mode.value, lastUpdated: mode.lastUpdated } };
}

function zappiOverlay(device: HomeyDeviceLike, capabilities: string[], values: DeviceCapabilityMap): DeviceEvOverlay {
  if (!isZappi(device) || values.onoff?.setable === false || !capabilities.includes('onoff')) {
    return { kind: 'standard', capabilities, capabilityObj: values };
  }
  return {
    kind: 'adapted', capabilities, capabilityObj: withModeSwitch(values),
    controlAdapter: { kind: 'capability_adapter', activationRequired: false, activationEnabled: true },
    binaryTarget: { kind: 'capability', writeCapabilityId: 'onoff', observationCapabilityId: 'evcharger_charging' },
  };
}

export const zappiAdapter: DeviceAdapter = {
  ...standardDeviceAdapter,
  matches: isZappi,
  matchesCapabilities: (capabilities) => capabilities.includes(SIGNATURE_CAPABILITY),
  overlay: zappiOverlay,
  normalize: whileBuiltInControlEnabled((_snapshot, capabilityId, value) => {
    // The app's switch says "a car draws now", not whether the Zappi may charge.
    if (capabilityId === 'evcharger_charging') return [];
    if (capabilityId !== 'onoff' || typeof value !== 'boolean') return [{ capabilityId, value }];
    return [{ capabilityId, value }, { capabilityId: 'evcharger_charging', value }];
  }),
};
