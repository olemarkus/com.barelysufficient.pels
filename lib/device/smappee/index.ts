/**
 * The Smappee app's EV Wall charger (`com.smappee`, `ev-wall` driver, Smappee
 * cloud and MQTT) at the SDK seam. See `notes/native-wiring/smappee.md`.
 *
 * The app has neither `evcharger_charging` nor `evcharger_charging_state`.
 * Its setable `charging_mode` (`normal`, `smart`, `paused`) is the only
 * control: a write PUTs the connector's mode to the Smappee cloud, and the
 * charger's MQTT charging state publishes the mode back. `cable_connected` and
 * `charging` carry the IEC state. The adapter reads the switch as "not
 * paused", writes it as `normal` or `paused`, and derives the plug state. The
 * app files the charger under Homey's `other` class; its identity is a charger.
 *
 * The app offers no current control: PELS starts and stops this charger only.
 */
import type { DeviceAdapter, DeviceEvOverlay, SwitchWrite } from '../deviceAdapter';
import { whileBuiltInControlEnabled } from '../deviceAdapter';
import { toCapabilityTimestampMs, type DeviceCapabilityMap } from '../managerControl';
import type { CapabilityValue, HomeyDeviceLike } from '../../utils/types';
import { standardDeviceAdapter } from '../standardDeviceAdapter';

const DRIVER_IDS = new Set(['homey:app:com.smappee:ev-wall', 'com.smappee:ev-wall']);
const MODE_CAPABILITY = 'charging_mode';
const CONNECTED_CAPABILITY = 'cable_connected';
const CHARGING_CAPABILITY = 'charging';
const PAUSED_MODE = 'paused';
/** The mode PELS resumes a session in: standard charging, which follows PELS's start and stop. */
const RESUME_MODE = 'normal';
const MODES: ReadonlySet<string> = new Set(['normal', 'smart', PAUSED_MODE]);

function isSmappeeEvWall(device: HomeyDeviceLike): boolean {
  return DRIVER_IDS.has(device.driverId.trim().toLowerCase());
}

type CapabilityReadings = Readonly<Partial<DeviceCapabilityMap>>;

function readMode(values: CapabilityReadings): CapabilityValue<string> | undefined {
  const mode = values[MODE_CAPABILITY];
  return typeof mode?.value === 'string' && MODES.has(mode.value) ? { ...mode, value: mode.value } : undefined;
}

function readBoolean(values: CapabilityReadings, capabilityId: string): CapabilityValue<boolean> | undefined {
  const capability = values[capabilityId];
  return typeof capability?.value === 'boolean' ? { ...capability, value: capability.value } : undefined;
}

function newestDate(readings: readonly CapabilityValue<unknown>[]): string | undefined {
  const dates = readings.flatMap((reading) => {
    const at = toCapabilityTimestampMs(reading.lastUpdated);
    return at === undefined ? [] : [at];
  });
  return dates.length === 0 ? undefined : new Date(Math.max(...dates)).toISOString();
}

/**
 * The plug state from the cable, the charging reading and the mode. No cable
 * is no car; a charging connector charges; a paused mode holds the car off;
 * otherwise the car is connected and takes nothing. A missing reading leaves
 * the state unread.
 */
function resolvePlugState(values: CapabilityReadings): CapabilityValue<string> | undefined {
  const connected = readBoolean(values, CONNECTED_CAPABILITY);
  if (!connected) return undefined;
  if (!connected.value) return { value: 'plugged_out', lastUpdated: newestDate([connected]) };
  const charging = readBoolean(values, CHARGING_CAPABILITY);
  const mode = readMode(values);
  if (!charging || !mode) return undefined;
  let value = 'plugged_in';
  if (charging.value) value = 'plugged_in_charging';
  else if (mode.value === PAUSED_MODE) value = 'plugged_in_paused';
  return { value, lastUpdated: newestDate([connected, charging, mode]) };
}

function withSmappeeObservation(device: HomeyDeviceLike, values: DeviceCapabilityMap): DeviceCapabilityMap {
  if (!isSmappeeEvWall(device)) return values;
  const mode = readMode(values);
  const plugState = resolvePlugState(values);
  return {
    ...values,
    ...(mode ? { evcharger_charging: { ...mode, value: mode.value !== PAUSED_MODE } } : {}),
    ...(plugState ? { evcharger_charging_state: plugState } : {}),
  };
}

function smappeeOverlay(device: HomeyDeviceLike, capabilities: string[], values: DeviceCapabilityMap): DeviceEvOverlay {
  if (!isSmappeeEvWall(device)) return { kind: 'standard', capabilities, capabilityObj: values };
  const capabilityObj = withSmappeeObservation(device, values);
  const derived = ['evcharger_charging', 'evcharger_charging_state'].filter((id) => capabilityObj[id] !== undefined);
  return {
    kind: 'adapted',
    capabilities: [...new Set([...capabilities, ...derived])],
    capabilityObj,
    controlAdapter: { kind: 'capability_adapter', activationRequired: false, activationEnabled: true },
    binaryTarget: { kind: 'capability', writeCapabilityId: MODE_CAPABILITY,
      observationCapabilityId: 'evcharger_charging' },
  };
}

/**
 * A switch request becomes the connector's mode. The app sets the mode on
 * Homey as soon as the cloud accepts it, before the charger reports it, so the
 * write is no observation: the switch is read from the reported mode.
 */
function switchWrite(...args: Parameters<DeviceAdapter['switchWrite']>): SwitchWrite {
  const [snapshot, request] = args;
  const plain = standardDeviceAdapter.switchWrite(snapshot, request);
  if (plain.kind !== 'write' || plain.write.capabilityId !== MODE_CAPABILITY || typeof request.value !== 'boolean') {
    return plain;
  }
  return {
    kind: 'write',
    write: { capabilityId: MODE_CAPABILITY, value: request.value ? RESUME_MODE : PAUSED_MODE },
    readBackAsWritten: false,
  };
}

export const smappeeAdapter: DeviceAdapter = {
  ...standardDeviceAdapter,
  matches: isSmappeeEvWall,
  matchesCapabilities: (capabilities) => [MODE_CAPABILITY, CONNECTED_CAPABILITY, CHARGING_CAPABILITY]
    .every((id) => capabilities.includes(id)),
  // The app files the EV Wall under Homey's `other` class.
  identity: (device) => isSmappeeEvWall(device)
    ? { ...device, class: 'evcharger', virtualClass: 'evcharger' } : device,
  overlay: smappeeOverlay,
  observation: (device) => withSmappeeObservation(device, standardDeviceAdapter.observation(device)),
  normalize: whileBuiltInControlEnabled((_snapshot, capabilityId, value, device) => {
    if (capabilityId !== MODE_CAPABILITY && capabilityId !== CONNECTED_CAPABILITY
      && capabilityId !== CHARGING_CAPABILITY) return [{ capabilityId, value }];
    const plugState = resolvePlugState(device.capabilitiesObj);
    return [
      { capabilityId, value },
      ...(capabilityId === MODE_CAPABILITY && typeof value === 'string' && MODES.has(value)
        ? [{ capabilityId: 'evcharger_charging', value: value !== PAUSED_MODE }] : []),
      ...(plugState ? [{ capabilityId: 'evcharger_charging_state', value: plugState.value }] : []),
    ];
  }),
  readRules: () => ({
    [MODE_CAPABILITY]: 'string', [CONNECTED_CAPABILITY]: 'boolean', [CHARGING_CAPABILITY]: 'boolean',
  }),
  switchWrite,
  recoverSwitchWrite: (snapshot, _raw, request) => switchWrite(snapshot, request),
};
