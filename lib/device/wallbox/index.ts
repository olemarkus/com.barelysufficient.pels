/**
 * The community Wallbox app (`nl.xseth.wallbox`, `wallbox` driver, Wallbox
 * cloud) at the SDK seam. See `notes/native-wiring/wallbox.md`.
 *
 * The app's `evcharger_charging` listener pauses or resumes the session, and
 * it publishes the switch as "charging now", which a resumed session waiting
 * for a full car or for the charger's own schedule never is. Its `status`
 * tells those apart: `Charging` and `Waiting` are a session PELS lets run,
 * `Paused` is one it paused. So the switch is read from the status.
 *
 * The charging current has no capability: the app's `change_ampere` card sets
 * the charger's maximum charging current in the Wallbox cloud, and every poll
 * (10 s after a command, otherwise every 123 s) publishes that configured
 * maximum on `measure_current`. That is the cloud's answer, not proof the
 * charger applied it, accepted as Futurehome's saved limit is; it reaches PELS
 * as the charger's current reading.
 */
import type { DeviceAdapter, DeviceEvOverlay, SwitchWrite } from '../deviceAdapter';
import { whileBuiltInControlEnabled } from '../deviceAdapter';
import type { DeviceCapabilityMap } from '../managerControl';
import type { HomeyDeviceLike } from '../../utils/types';
import { standardDeviceAdapter } from '../standardDeviceAdapter';

const DRIVER_IDS = new Set(['homey:app:nl.xseth.wallbox:wallbox', 'nl.xseth.wallbox:wallbox']);
const STATUS_CAPABILITY = 'status';
/** The configured maximum charging current, in amps, as the app publishes it. */
const CONFIGURED_CURRENT_CAPABILITY = 'measure_current';
const INSTALLATION_CURRENT = 'available_installation_current';
/** Statuses of a session PELS lets run: drawing, or waiting for the car or a schedule. */
const RUNNING_STATUSES = new Set(['Charging', 'Waiting']);

function isWallbox(device: HomeyDeviceLike): boolean {
  return DRIVER_IDS.has(device.driverId.trim().toLowerCase());
}

function readCurrentA(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/** The switch read from the status, and the configured current as the charger's current reading. */
function withWallboxObservation(values: DeviceCapabilityMap): DeviceCapabilityMap {
  const status = values[STATUS_CAPABILITY];
  const charging = values.evcharger_charging;
  const configured = values[CONFIGURED_CURRENT_CAPABILITY];
  const currentA = readCurrentA(configured?.value);
  return {
    ...values,
    ...(charging !== undefined && typeof status?.value === 'string' ? {
      evcharger_charging: { ...charging, value: RUNNING_STATUSES.has(status.value), lastUpdated: status.lastUpdated },
    } : {}),
    ...(currentA !== undefined ? {
      [INSTALLATION_CURRENT]: { value: currentA, setable: false, lastUpdated: configured?.lastUpdated },
    } : {}),
  };
}

function wallboxOverlay(device: HomeyDeviceLike, capabilities: string[], values: DeviceCapabilityMap): DeviceEvOverlay {
  if (!isWallbox(device)) return { kind: 'standard', capabilities, capabilityObj: values };
  return {
    kind: 'adapted', capabilities, capabilityObj: withWallboxObservation(values),
    controlAdapter: { kind: 'capability_adapter', activationRequired: false, activationEnabled: true },
    binaryTarget: { kind: 'canonical' },
  };
}

export const wallboxAdapter: DeviceAdapter = {
  ...standardDeviceAdapter,
  matches: isWallbox,
  matchesCapabilities: (capabilities) => capabilities.includes(STATUS_CAPABILITY)
    && capabilities.includes('locked') && capabilities.includes('evcharger_charging'),
  overlay: wallboxOverlay,
  normalize: whileBuiltInControlEnabled((_snapshot, capabilityId, value) => {
    // The app's switch says "charging now", not whether PELS lets the session run.
    if (capabilityId === 'evcharger_charging') return [];
    if (capabilityId === STATUS_CAPABILITY && typeof value === 'string') {
      return [{ capabilityId, value }, { capabilityId: 'evcharger_charging', value: RUNNING_STATUSES.has(value) }];
    }
    const currentA = capabilityId === CONFIGURED_CURRENT_CAPABILITY ? readCurrentA(value) : undefined;
    return currentA === undefined ? [{ capabilityId, value }]
      : [{ capabilityId, value }, { capabilityId: INSTALLATION_CURRENT, value: currentA }];
  }),
  // Read from the status, the switch is no observation of PELS's own write.
  switchWrite: (snapshot, request, sessions): SwitchWrite => {
    const plain = standardDeviceAdapter.switchWrite(snapshot, request, sessions);
    return plain.kind === 'write' && typeof request.value === 'boolean'
      ? { ...plain, readBackAsWritten: false } : plain;
  },
  recoverSwitchWrite: (snapshot, _raw, request, sessions) => wallboxAdapter.switchWrite(snapshot, request, sessions),
  currentBindings: (device) => isWallbox(device) ? [{
    deviceId: device.id,
    current: { kind: 'action_only' },
    appUri: 'homey:app:nl.xseth.wallbox',
    actionId: 'change_ampere',
    scope: { kind: 'charger' },
    sharesInstallation: () => false,
    currentArguments: (currentA) => ({ ampere: currentA }),
  }] : [],
};
