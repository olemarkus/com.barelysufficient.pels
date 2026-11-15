/**
 * The Smappee app's EV Wall charger (`com.smappee`, `ev-wall` driver, Smappee
 * cloud and MQTT) at the SDK seam. See `notes/native-wiring/smappee.md`.
 *
 * The setable `charging_mode` (`normal`, `smart`, `paused`) is the only
 * control: a write PUTs the connector's mode to the Smappee cloud, and the
 * charger's MQTT charging state publishes the mode back. `cable_connected`
 * and a "the connector is charging now" reading carry the IEC state: the 1.3
 * app names that reading `charging`; the 1.4 app removes `charging` and
 * publishes it as its own `evcharger_charging`, which takes no write, next to
 * its own `evcharger_charging_state`. The adapter reads the switch as "not
 * paused", writes it as `normal` or `paused`, and derives the plug state, on
 * both app generations: the 1.4 app's own `evcharger_charging` and
 * `evcharger_charging_state` are read as the connector reading only, never as
 * the switch or the plug state. The 1.3 app files the charger under Homey's
 * `other` class; its identity is a charger.
 *
 * The app offers no current control (`dim` is the charger LED's brightness):
 * PELS starts and stops this charger only.
 */
import type { CapabilityUpdate, DeviceAdapter, DeviceEvOverlay, SwitchWrite } from '../deviceAdapter';
import { whileBuiltInControlEnabled } from '../deviceAdapter';
import { toCapabilityTimestampMs, type DeviceCapabilityMap } from '../managerControl';
import type { CapabilityValue, HomeyDeviceLike } from '../../utils/types';
import { standardDeviceAdapter } from '../standardDeviceAdapter';

const DRIVER_IDS = new Set(['homey:app:com.smappee:ev-wall', 'com.smappee:ev-wall']);
const MODE_CAPABILITY = 'charging_mode';
const CONNECTED_CAPABILITY = 'cable_connected';
/** The 1.3 app's "the connector is charging now". */
const CHARGING_CAPABILITY = 'charging';
/** The switch PELS reads from the mode; on the 1.4 app, also the app's own "charging now". */
const SWITCH_CAPABILITY = 'evcharger_charging';
const PLUG_STATE_CAPABILITY = 'evcharger_charging_state';
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

/**
 * Whether the connector is charging now: the 1.3 app's `charging` when there
 * is one, else the 1.4 app's own `evcharger_charging`, which it declares. An
 * adapted map carries the reading as `charging` (`withSmappeeObservation`), so
 * reading it again, after its `evcharger_charging` became the switch, reads the
 * same connector.
 */
function readConnectorCharging(
  capabilities: readonly string[], values: CapabilityReadings,
): CapabilityValue<boolean> | undefined {
  return readBoolean(values, CHARGING_CAPABILITY)
    ?? (capabilities.includes(SWITCH_CAPABILITY) ? readBoolean(values, SWITCH_CAPABILITY) : undefined);
}

function newestDate(readings: readonly CapabilityValue<unknown>[]): string | undefined {
  const dates = readings.flatMap((reading) => {
    const at = toCapabilityTimestampMs(reading.lastUpdated);
    return at === undefined ? [] : [at];
  });
  return dates.length === 0 ? undefined : new Date(Math.max(...dates)).toISOString();
}

/**
 * The plug state from the cable, the connector reading and the mode. No cable
 * is no car; a charging connector charges; a paused mode holds the car off;
 * otherwise the car is connected and takes nothing. A missing reading leaves
 * the state unread.
 */
function resolvePlugState(
  connected: CapabilityValue<boolean> | undefined,
  charging: CapabilityValue<boolean> | undefined,
  mode: CapabilityValue<string> | undefined,
): CapabilityValue<string> | undefined {
  if (!connected) return undefined;
  if (!connected.value) return { value: 'plugged_out', lastUpdated: newestDate([connected]) };
  if (!charging || !mode) return undefined;
  let value = 'plugged_in';
  if (charging.value) value = 'plugged_in_charging';
  else if (mode.value === PAUSED_MODE) value = 'plugged_in_paused';
  return { value, lastUpdated: newestDate([connected, charging, mode]) };
}

function plugStateOf(capabilities: readonly string[], values: CapabilityReadings): CapabilityValue<string> | undefined {
  return resolvePlugState(
    readBoolean(values, CONNECTED_CAPABILITY), readConnectorCharging(capabilities, values), readMode(values),
  );
}

/**
 * The switch read from the mode and the derived plug state, in place of the
 * 1.4 app's own `evcharger_charging` and `evcharger_charging_state`. The
 * connector reading stays under `charging`.
 */
function withSmappeeObservation(
  device: HomeyDeviceLike, capabilities: readonly string[], values: DeviceCapabilityMap,
): DeviceCapabilityMap {
  if (!isSmappeeEvWall(device)) return values;
  const mode = readMode(values);
  const charging = readConnectorCharging(capabilities, values);
  const plugState = plugStateOf(capabilities, values);
  const {
    [SWITCH_CAPABILITY]: _appCharging, [PLUG_STATE_CAPABILITY]: _appPlugState, ...readings
  } = values;
  return {
    ...readings,
    ...(charging ? { [CHARGING_CAPABILITY]: charging } : {}),
    ...(mode ? { [SWITCH_CAPABILITY]: { ...mode, value: mode.value !== PAUSED_MODE } } : {}),
    ...(plugState ? { [PLUG_STATE_CAPABILITY]: plugState } : {}),
  };
}

function smappeeOverlay(device: HomeyDeviceLike, capabilities: string[], values: DeviceCapabilityMap): DeviceEvOverlay {
  if (!isSmappeeEvWall(device)) return { kind: 'standard', capabilities, capabilityObj: values };
  const capabilityObj = withSmappeeObservation(device, capabilities, values);
  const derived = [SWITCH_CAPABILITY, PLUG_STATE_CAPABILITY];
  return {
    kind: 'adapted',
    capabilities: [
      ...capabilities.filter((id) => !derived.includes(id)),
      ...derived.filter((id) => capabilityObj[id] !== undefined),
    ],
    capabilityObj,
    controlAdapter: { kind: 'capability_adapter', activationRequired: false, activationEnabled: true },
    binaryTarget: { kind: 'capability', writeCapabilityId: MODE_CAPABILITY,
      observationCapabilityId: SWITCH_CAPABILITY },
  };
}

/**
 * One live report. `device` is the accepted read with the report applied, so
 * its `evcharger_charging` is still the 1.4 app's connector reading. That
 * report and the app's own plug state only feed the derived plug state.
 */
function normalizeReport(capabilityId: string, value: unknown, device: HomeyDeviceLike): CapabilityUpdate[] {
  const appReport = capabilityId === SWITCH_CAPABILITY || capabilityId === PLUG_STATE_CAPABILITY;
  if (!appReport && capabilityId !== MODE_CAPABILITY && capabilityId !== CONNECTED_CAPABILITY
    && capabilityId !== CHARGING_CAPABILITY) return [{ capabilityId, value }];
  const plugState = plugStateOf(device.capabilities, device.capabilitiesObj);
  return [
    ...(appReport ? [] : [{ capabilityId, value }]),
    ...(capabilityId === MODE_CAPABILITY && typeof value === 'string' && MODES.has(value)
      ? [{ capabilityId: SWITCH_CAPABILITY, value: value !== PAUSED_MODE }] : []),
    ...(plugState ? [{ capabilityId: PLUG_STATE_CAPABILITY, value: plugState.value }] : []),
  ];
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
  matchesCapabilities: (capabilities) => [MODE_CAPABILITY, CONNECTED_CAPABILITY]
    .every((id) => capabilities.includes(id))
    && (capabilities.includes(CHARGING_CAPABILITY) || capabilities.includes(SWITCH_CAPABILITY)),
  // The 1.3 app files the EV Wall under Homey's `other` class.
  identity: (device) => isSmappeeEvWall(device)
    ? { ...device, class: 'evcharger', virtualClass: 'evcharger' } : device,
  overlay: smappeeOverlay,
  observation: (device) => withSmappeeObservation(
    device, device.capabilities, standardDeviceAdapter.observation(device),
  ),
  normalize: whileBuiltInControlEnabled((_snapshot, capabilityId, value, device) => (
    normalizeReport(capabilityId, value, device)
  )),
  readRules: () => ({
    [MODE_CAPABILITY]: 'string', [CONNECTED_CAPABILITY]: 'boolean', [CHARGING_CAPABILITY]: 'boolean',
  }),
  switchWrite,
  recoverSwitchWrite: (snapshot, _raw, request) => switchWrite(snapshot, request),
};
