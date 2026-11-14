/**
 * The go-e Charger app (`com.go-e.charger`, local HTTP API, every driver from
 * `go-eCharger_V1` to `go-eCharger_V4`, `CORE` and `PRO`) at the SDK seam. See
 * `notes/native-wiring/goe.md`.
 *
 * The app has neither `evcharger_charging` nor `evcharger_charging_state`.
 * Its setable `is_allowed` switch forces charging off or hands it back to the
 * charger, and the app's 5 s poll publishes the charger's own answer to it
 * (`alw`). The plug state arrives as `status`. The adapter reads and writes
 * the switch on `is_allowed`, publishes it as `evcharger_charging`, and
 * derives the plug state from `status` and the switch.
 *
 * The charging current is `current_limit`, which the app declares read-only:
 * its `change_current` card sets the charger's current and the next poll
 * publishes the charger's `amp` back on `current_limit`.
 */
import type { DeviceAdapter, DeviceEvOverlay } from '../deviceAdapter';
import { whileBuiltInControlEnabled } from '../deviceAdapter';
import { toCapabilityTimestampMs, type DeviceCapabilityMap } from '../managerControl';
import type { ChargerPhaseReport } from '../chargerPhasePreset';
import type { CapabilityValue, HomeyDeviceLike } from '../../utils/types';
import { standardDeviceAdapter } from '../standardDeviceAdapter';

const DRIVER_PREFIXES = ['homey:app:com.go-e.charger:', 'com.go-e.charger:'];
const SWITCH_CAPABILITY = 'is_allowed';
const STATUS_CAPABILITY = 'status';
const CURRENT_CAPABILITY = 'current_limit';
const PHASES_CAPABILITY = 'num_phases';
const INSTALLATION_CURRENT = 'available_installation_current';
const MIN_CURRENT_A = 6;
const MAX_CURRENT_A = 32;

function isGoeCharger(device: HomeyDeviceLike): boolean {
  const driverId = device.driverId.trim().toLowerCase();
  return DRIVER_PREFIXES.some((prefix) => driverId.startsWith(prefix));
}

type CapabilityReadings = Readonly<Partial<DeviceCapabilityMap>>;

function readCurrentA(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= MIN_CURRENT_A && value <= MAX_CURRENT_A
    ? value : undefined;
}

/**
 * The plug state from the charger's status and the switch: no car, a car
 * drawing, a car the switch holds off, a car that has finished, or a connected
 * car that takes nothing yet. An error, an unknown status or a missing switch
 * leaves the state unread.
 */
function resolvePlugValue(status: unknown, allowed: unknown): string | undefined {
  if (status === 'station_idle') return 'plugged_out';
  if (status === 'car_charging') return 'plugged_in_charging';
  if (status !== 'station_waiting' && status !== 'car_finished') return undefined;
  if (typeof allowed !== 'boolean') return undefined;
  if (!allowed) return 'plugged_in_paused';
  return status === 'car_finished' ? 'plugged_in_finished' : 'plugged_in';
}

type ReadingDate = CapabilityValue<unknown>['lastUpdated'];

function newerDate(left: ReadingDate, right: ReadingDate): ReadingDate {
  const leftMs = toCapabilityTimestampMs(left);
  const rightMs = toCapabilityTimestampMs(right);
  if (leftMs === undefined) return right;
  if (rightMs === undefined) return left;
  return rightMs > leftMs ? right : left;
}

/**
 * Dated by the newest reading it rests on: a connected car's state follows the
 * switch, so a switch change after the last status report dates it.
 */
function resolvePlugState(values: CapabilityReadings): CapabilityValue<string> | undefined {
  const status = values[STATUS_CAPABILITY];
  const allowed = values[SWITCH_CAPABILITY];
  const value = resolvePlugValue(status?.value, allowed?.value);
  if (value === undefined) return undefined;
  const readsSwitch = value !== 'plugged_out' && value !== 'plugged_in_charging';
  const lastUpdated = readsSwitch ? newerDate(status?.lastUpdated, allowed?.lastUpdated) : status?.lastUpdated;
  return { value, lastUpdated };
}

function withGoeObservation(device: HomeyDeviceLike, values: DeviceCapabilityMap): DeviceCapabilityMap {
  if (!isGoeCharger(device)) return values;
  const allowed = values[SWITCH_CAPABILITY];
  const plugState = resolvePlugState(values);
  const current = values[CURRENT_CAPABILITY];
  const currentA = readCurrentA(current?.value);
  return {
    ...values,
    ...(typeof allowed?.value === 'boolean' ? { evcharger_charging: { ...allowed } } : {}),
    ...(plugState ? { evcharger_charging_state: plugState } : {}),
    ...(currentA !== undefined ? {
      [INSTALLATION_CURRENT]: { value: currentA, setable: false, lastUpdated: current?.lastUpdated },
    } : {}),
  };
}

function goeOverlay(device: HomeyDeviceLike, capabilities: string[], values: DeviceCapabilityMap): DeviceEvOverlay {
  if (!isGoeCharger(device)) return { kind: 'standard', capabilities, capabilityObj: values };
  const capabilityObj = withGoeObservation(device, values);
  const derived = ['evcharger_charging', 'evcharger_charging_state'].filter((id) => capabilityObj[id] !== undefined);
  return {
    kind: 'adapted',
    capabilities: [...new Set([...capabilities, ...derived])],
    capabilityObj,
    // The charger keeps its current across a stop, so the planned current
    // goes out before the switch: an old 32 A setting cannot start the session.
    controlAdapter: { kind: 'capability_adapter', activationRequired: false, activationEnabled: true,
      activationOrder: 'current_before_start' },
    binaryTarget: { kind: 'capability', writeCapabilityId: SWITCH_CAPABILITY,
      observationCapabilityId: 'evcharger_charging' },
  };
}

// `num_phases` reads 1 only when the charger is forced onto one phase, and
// otherwise holds the app's default of 3. Three phases on a Norwegian IT grid
// draw sqrt(3) * 230 W/A, which the three-phase preset does not model, so only
// single-phase charging is reported.
function resolvePhaseReport(device: HomeyDeviceLike): ChargerPhaseReport {
  return isGoeCharger(device) && device.capabilitiesObj[PHASES_CAPABILITY]?.value === '1'
    ? { kind: 'reported', preset: 'ev_charger_1_phase' }
    : { kind: 'not_reported' };
}

export const goeAdapter: DeviceAdapter = {
  ...standardDeviceAdapter,
  matches: isGoeCharger,
  matchesCapabilities: (capabilities) => [SWITCH_CAPABILITY, STATUS_CAPABILITY, CURRENT_CAPABILITY, 'is_connected']
    .every((id) => capabilities.includes(id)),
  overlay: goeOverlay,
  observation: (device) => withGoeObservation(device, standardDeviceAdapter.observation(device)),
  normalize: whileBuiltInControlEnabled((_snapshot, capabilityId, value, device) => {
    if (capabilityId === CURRENT_CAPABILITY) {
      const currentA = readCurrentA(value);
      return currentA === undefined ? [{ capabilityId, value }]
        : [{ capabilityId, value }, { capabilityId: INSTALLATION_CURRENT, value: currentA }];
    }
    if (capabilityId !== SWITCH_CAPABILITY && capabilityId !== STATUS_CAPABILITY) return [{ capabilityId, value }];
    const plugState = resolvePlugState(device.capabilitiesObj);
    return [
      { capabilityId, value },
      ...(capabilityId === SWITCH_CAPABILITY && typeof value === 'boolean'
        ? [{ capabilityId: 'evcharger_charging', value }] : []),
      ...(plugState ? [{ capabilityId: 'evcharger_charging_state', value: plugState.value }] : []),
    ];
  }),
  readRules: () => ({
    [STATUS_CAPABILITY]: 'string', [SWITCH_CAPABILITY]: 'boolean', [CURRENT_CAPABILITY]: 'number',
    is_connected: 'boolean',
  }),
  phaseReport: resolvePhaseReport,
  currentBindings: (device) => isGoeCharger(device) ? [{
    deviceId: device.id,
    current: { kind: 'action_only' },
    appUri: 'homey:app:com.go-e.charger',
    actionId: 'change_current',
    scope: { kind: 'charger' },
    sharesInstallation: () => false,
    currentArguments: (currentA) => ({ action_amps: currentA }),
  }] : [],
};
