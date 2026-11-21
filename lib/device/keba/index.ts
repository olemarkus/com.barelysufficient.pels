/**
 * The KEBA app (`se.cohen.keba`, `keba-p30` driver for the P20 and P30, local
 * UDP) at the SDK seam. See `notes/native-wiring/keba.md`.
 *
 * The app has neither `evcharger_charging` nor `evcharger_charging_state`.
 * Its setable `onoff` enables or disables charging, and the app's 10 s poll
 * publishes the charger's own enabled state on it. The plug and the session
 * arrive as two booleans, `plug_status` and `charge_status`. The adapter
 * reads and writes the switch on `onoff`, publishes it as
 * `evcharger_charging`, and derives the plug state from the booleans and the
 * switch.
 *
 * The charging current is `charge_power`, in amps and read-only: the app's
 * `set_charge_power` card sets the charger's current and the next poll
 * publishes the charger's own limit back on `charge_power`.
 *
 * The `keba-p40` driver has no switch, so it is not adapted.
 */
import type { DeviceAdapter, DeviceEvOverlay } from '../deviceAdapter';
import { whileBuiltInControlEnabled } from '../deviceAdapter';
import { toCapabilityTimestampMs, type DeviceCapabilityMap } from '../managerControl';
import type { HomeyDeviceLike } from '../../utils/types';
import { standardDeviceAdapter } from '../standardDeviceAdapter';

const DRIVER_IDS = new Set(['homey:app:se.cohen.keba:keba-p30', 'se.cohen.keba:keba-p30']);
const SWITCH_CAPABILITY = 'onoff';
const PLUG_CAPABILITY = 'plug_status';
const CHARGING_CAPABILITY = 'charge_status';
const CURRENT_CAPABILITY = 'charge_power';
const INSTALLATION_CURRENT = 'available_installation_current';
const MIN_CURRENT_A = 6;
const MAX_CURRENT_A = 32;

function isKebaCharger(device: HomeyDeviceLike): boolean {
  return DRIVER_IDS.has(device.driverId.trim().toLowerCase());
}

function readCurrentA(value: unknown): number | undefined {
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
 * The plug state from the plug and session booleans and the switch: no car, a
 * car drawing, a car the switch holds off, or a connected car that takes
 * nothing. A missing or malformed reading leaves the state unread.
 */
function resolvePlugState(values: CapabilityReadings): { value: string; lastUpdated?: string } | undefined {
  const plugged = readBoolean(values, PLUG_CAPABILITY);
  if (!plugged) return undefined;
  if (!plugged.value) return { value: 'plugged_out', lastUpdated: newestDate([plugged]) };
  const charging = readBoolean(values, CHARGING_CAPABILITY);
  const enabled = readBoolean(values, SWITCH_CAPABILITY);
  if (!charging || !enabled) return undefined;
  let value = 'plugged_in';
  if (charging.value) value = 'plugged_in_charging';
  else if (!enabled.value) value = 'plugged_in_paused';
  return { value, lastUpdated: newestDate([plugged, charging, enabled]) };
}

function withKebaObservation(device: HomeyDeviceLike, values: DeviceCapabilityMap): DeviceCapabilityMap {
  if (!isKebaCharger(device)) return values;
  const enabled = values[SWITCH_CAPABILITY];
  const plugState = resolvePlugState(values);
  const current = values[CURRENT_CAPABILITY];
  const currentA = readCurrentA(current?.value);
  return {
    ...values,
    ...(typeof enabled?.value === 'boolean' ? { evcharger_charging: { ...enabled } } : {}),
    ...(plugState ? { evcharger_charging_state: plugState } : {}),
    ...(currentA !== undefined ? {
      [INSTALLATION_CURRENT]: { value: currentA, setable: false, lastUpdated: current?.lastUpdated },
    } : {}),
  };
}

function kebaOverlay(device: HomeyDeviceLike, capabilities: string[], values: DeviceCapabilityMap): DeviceEvOverlay {
  if (!isKebaCharger(device)) return { kind: 'standard', capabilities, capabilityObj: values };
  const capabilityObj = withKebaObservation(device, values);
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

export const kebaAdapter: DeviceAdapter = {
  ...standardDeviceAdapter,
  matches: isKebaCharger,
  matchesCapabilities: (capabilities) => [SWITCH_CAPABILITY, PLUG_CAPABILITY, CHARGING_CAPABILITY, CURRENT_CAPABILITY,
    'charge_power_selector'].every((id) => capabilities.includes(id)),
  overlay: kebaOverlay,
  observation: (device) => withKebaObservation(device, standardDeviceAdapter.observation(device)),
  normalize: whileBuiltInControlEnabled((_snapshot, capabilityId, value, device) => {
    if (capabilityId === CURRENT_CAPABILITY) {
      const currentA = readCurrentA(value);
      return currentA === undefined ? [{ capabilityId, value }]
        : [{ capabilityId, value }, { capabilityId: INSTALLATION_CURRENT, value: currentA }];
    }
    if (capabilityId !== SWITCH_CAPABILITY && capabilityId !== PLUG_CAPABILITY
      && capabilityId !== CHARGING_CAPABILITY) return [{ capabilityId, value }];
    const plugState = resolvePlugState(device.capabilitiesObj);
    return [
      { capabilityId, value },
      ...(capabilityId === SWITCH_CAPABILITY && typeof value === 'boolean'
        ? [{ capabilityId: 'evcharger_charging', value }] : []),
      ...(plugState ? [{ capabilityId: 'evcharger_charging_state', value: plugState.value }] : []),
    ];
  }),
  readRules: () => ({
    [PLUG_CAPABILITY]: 'boolean', [CHARGING_CAPABILITY]: 'boolean', [CURRENT_CAPABILITY]: 'number',
  }),
  currentBindings: (device) => isKebaCharger(device) ? [{
    deviceId: device.id,
    current: { kind: 'action_only' },
    appUri: 'homey:app:se.cohen.keba',
    actionId: 'set_charge_power',
    scope: { kind: 'charger' },
    sharesInstallation: () => false,
    supportsAppAction: true,
    currentArguments: (currentA) => ({ charge_power: currentA }),
  }] : [],
};
