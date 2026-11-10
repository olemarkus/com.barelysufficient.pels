/**
 * The amina app (`com.aminacharging`, `amina-s` driver, Zigbee) at the SDK
 * seam. See `notes/native-wiring/amina.md`.
 *
 * The app has neither `evcharger_charging` nor `evcharger_charging_state`.
 * Its `onoff` is the charger's Zigbee On/Off cluster, which enables or
 * disables charging, and its EV status arrives as separate booleans:
 * `ev_connected`, `power_delivered` and `charging_paused`. The adapter reads
 * the switch from `onoff`, writes it there, and derives the plug state from
 * the booleans.
 *
 * The charging current has no capability: the app's `set_charging_current`
 * card moves the charger's level and then saves the same value to the
 * device's `maxCurrent` setting, which is also read from the charger at
 * startup. As Futurehome's saved limit, it is the limit Homey last sent and
 * the charger accepted, not proof the car draws it.
 */
import type { DeviceAdapter, DeviceEvOverlay } from '../deviceAdapter';
import { whileBuiltInControlEnabled } from '../deviceAdapter';
import { toCapabilityTimestampMs, type DeviceCapabilityMap } from '../managerControl';
import type { ChargerPhaseReport } from '../chargerPhasePreset';
import type { HomeyDeviceLike } from '../../utils/types';
import { standardDeviceAdapter } from '../standardDeviceAdapter';
import { SettingCurrentLimitSession } from '../settingCurrentLimitSession';

const DRIVER_IDS = new Set(['homey:app:com.aminacharging:amina-s', 'com.aminacharging:amina-s']);
const SWITCH_CAPABILITY = 'onoff';
const CONNECTED_CAPABILITY = 'ev_connected';
const DELIVERING_CAPABILITY = 'power_delivered';
const PAUSED_CAPABILITY = 'charging_paused';
const STATUS_CAPABILITIES: ReadonlySet<string> = new Set([CONNECTED_CAPABILITY, DELIVERING_CAPABILITY,
  PAUSED_CAPABILITY]);
const MAX_CURRENT_SETTING = 'maxCurrent';
const SINGLE_PHASE_SETTING = 'singlePhase';
const INSTALLATION_CURRENT = 'available_installation_current';
const MIN_CURRENT_A = 6;
const MAX_CURRENT_A = 32;

function isAminaCharger(device: HomeyDeviceLike): boolean {
  return DRIVER_IDS.has(device.driverId.trim().toLowerCase());
}

/** The current limit Homey last sent, or no reading when the setting holds a value outside 6-32 A. */
function readCurrentLimit(device: HomeyDeviceLike): number | undefined {
  const value = device.settings[MAX_CURRENT_SETTING];
  return typeof value === 'number' && Number.isInteger(value) && value >= MIN_CURRENT_A && value <= MAX_CURRENT_A
    ? value : undefined;
}

type CapabilityReadings = Readonly<Partial<DeviceCapabilityMap>>;
type BooleanReading = { value: boolean; lastUpdated?: string | Date | number | null };

function readBoolean(values: CapabilityReadings, capabilityId: string): BooleanReading | undefined {
  const capability = values[capabilityId];
  return typeof capability?.value === 'boolean'
    ? { value: capability.value, lastUpdated: capability.lastUpdated } : undefined;
}

/** The newest date among the readings a derived value stands on, or none when none is dated. */
function newestDate(readings: readonly BooleanReading[]): string | undefined {
  const dates = readings.flatMap((reading) => {
    const at = toCapabilityTimestampMs(reading.lastUpdated);
    return at === undefined ? [] : [at];
  });
  return dates.length === 0 ? undefined : new Date(Math.max(...dates)).toISOString();
}

/**
 * The plug state from the EV status booleans and the switch. A connected
 * charger that delivers power charges; one switched off, or paused by the
 * car or charger, is paused; otherwise the car is connected and takes
 * nothing. A missing or malformed reading leaves the state unread.
 */
function resolvePlugState(values: CapabilityReadings): { value: string; lastUpdated?: string } | undefined {
  const connected = readBoolean(values, CONNECTED_CAPABILITY);
  if (!connected) return undefined;
  if (!connected.value) return { value: 'plugged_out', lastUpdated: newestDate([connected]) };
  const delivering = readBoolean(values, DELIVERING_CAPABILITY);
  const paused = readBoolean(values, PAUSED_CAPABILITY);
  const enabled = readBoolean(values, SWITCH_CAPABILITY);
  if (!delivering || !paused || !enabled) return undefined;
  let value = 'plugged_in';
  if (delivering.value) value = 'plugged_in_charging';
  else if (!enabled.value || paused.value) value = 'plugged_in_paused';
  return { value, lastUpdated: newestDate([connected, delivering, paused, enabled]) };
}

function withAminaObservation(device: HomeyDeviceLike, values: DeviceCapabilityMap): DeviceCapabilityMap {
  if (!isAminaCharger(device)) return values;
  const enabled = values[SWITCH_CAPABILITY];
  const plugState = resolvePlugState(values);
  const currentA = readCurrentLimit(device);
  return {
    ...values,
    ...(typeof enabled?.value === 'boolean' ? { evcharger_charging: { ...enabled } } : {}),
    ...(plugState ? { evcharger_charging_state: plugState } : {}),
    ...(currentA !== undefined ? { [INSTALLATION_CURRENT]: { value: currentA, setable: false } } : {}),
  };
}

function aminaOverlay(device: HomeyDeviceLike, capabilities: string[], values: DeviceCapabilityMap): DeviceEvOverlay {
  if (!isAminaCharger(device)) return { kind: 'standard', capabilities, capabilityObj: values };
  const capabilityObj = withAminaObservation(device, values);
  const derived = ['evcharger_charging', 'evcharger_charging_state'].filter((id) => capabilityObj[id] !== undefined);
  return {
    kind: 'adapted',
    capabilities: [...new Set([...capabilities, ...derived])],
    capabilityObj,
    // The charger keeps its last level across a stop, so the planned current
    // goes out before the switch: an old 32 A level cannot start the session.
    controlAdapter: { kind: 'capability_adapter', activationRequired: false, activationEnabled: true,
      activationOrder: 'current_before_start' },
    binaryTarget: { kind: 'capability', writeCapabilityId: SWITCH_CAPABILITY,
      observationCapabilityId: 'evcharger_charging' },
  };
}

// The single-phase setting says how the charger charges. Three phases on a
// Norwegian IT grid draw sqrt(3) * 230 W/A, which the three-phase preset does
// not model, so only single-phase charging is reported.
function resolvePhaseReport(device: HomeyDeviceLike): ChargerPhaseReport {
  return isAminaCharger(device) && device.settings[SINGLE_PHASE_SETTING] === true
    ? { kind: 'reported', preset: 'ev_charger_1_phase' }
    : { kind: 'not_reported' };
}

export const aminaAdapter: DeviceAdapter = {
  ...standardDeviceAdapter,
  matches: isAminaCharger,
  matchesCapabilities: (capabilities) => capabilities.includes(SWITCH_CAPABILITY)
    && [...STATUS_CAPABILITIES].every((id) => capabilities.includes(id)),
  overlay: aminaOverlay,
  observation: (device) => withAminaObservation(device, standardDeviceAdapter.observation(device)),
  normalize: whileBuiltInControlEnabled((_snapshot, capabilityId, value, device) => {
    if (capabilityId !== SWITCH_CAPABILITY && !STATUS_CAPABILITIES.has(capabilityId)) return [{ capabilityId, value }];
    const plugState = resolvePlugState(device.capabilitiesObj);
    return [
      { capabilityId, value },
      ...(capabilityId === SWITCH_CAPABILITY && typeof value === 'boolean'
        ? [{ capabilityId: 'evcharger_charging', value }] : []),
      ...(plugState ? [{ capabilityId: 'evcharger_charging_state', value: plugState.value }] : []),
    ];
  }),
  readRules: () => ({
    [CONNECTED_CAPABILITY]: 'boolean', [DELIVERING_CAPABILITY]: 'boolean', [PAUSED_CAPABILITY]: 'boolean',
  }),
  phaseReport: resolvePhaseReport,
  currentBindings: (device) => isAminaCharger(device) ? [{
    deviceId: device.id,
    current: { kind: 'action_only' },
    appUri: 'homey:app:com.aminacharging',
    actionId: 'set_charging_current',
    scope: { kind: 'charger' },
    sharesInstallation: () => false,
    currentArguments: (currentA) => ({ max: currentA }),
  }] : [],
  createSession: () => new SettingCurrentLimitSession({ matches: isAminaCharger, readCurrentLimit }),
};
