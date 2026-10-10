import { isDeviceStartPolicyMap } from '../../../shared-domain/src/settings/deviceStartPolicy.ts';
import { parseBatteryControlDevices } from '../../../shared-domain/src/settings/batteryControlDevices.ts';
import { readModeAliases as readSharedModeAliases } from '../../../shared-domain/src/settings/modeAliases.ts';
import {
  readTemperatureControlModes, temperatureControlDisabledDevices,
} from '../../../shared-domain/src/settings/temperatureControl.ts';
import { state } from './state.ts';
import {
  BATTERY_CONTROL_DEVICES,
  BUDGET_EXEMPT_DEVICES,
  CAPACITY_PRIORITIES,
  MODE_ALIASES,
  MODE_DEVICE_TARGETS,
  NATIVE_EV_WIRING_DEVICES,
  OPERATING_MODE_SETTING,
  RESPECT_EXTERNAL_OFF_DEVICES,
  DEVICE_START_POLICIES,
  TEMPERATURE_CONTROL_DISABLED_DEVICES,
  TEMPERATURE_CONTROL_MODES,
  homeScopedSettingsKey,
  CONTROLLABLE_DEVICES,
  MANAGED_DEVICES,
} from '../../../shared-domain/src/settings/settingsKeys.ts';
import { getSetting } from './homey.ts';

export type ModeSettingsRead = {
  mode: unknown;
  priorities: unknown;
  targets: unknown;
  controllables: unknown;
  managed: unknown;
  budgetExempt: unknown;
  respectExternalOff: unknown;
  deviceStartPolicies: unknown;
  temperatureControlDisabled: unknown;
  temperatureControlModes: unknown;
  nativeWiring: unknown;
  aliases: unknown;
  batteryControl: unknown;
};

export const readBooleanSettingMap = (value: unknown): Record<string, boolean> => (
  value && typeof value === 'object' ? value as Record<string, boolean> : {}
);

// Match the runtime's whole-map validation and retain last-good UI state when
// one malformed entry makes the outer settings read unavailable.
export const readStrictBooleanSettingMap = (
  value: unknown,
): Record<string, boolean> | null => {
  if (value === undefined || value === null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) return null;
  const entries = Object.entries(value);
  if (!entries.every(([, entry]) => typeof entry === 'boolean')) return null;
  return Object.fromEntries(entries.filter(([, entry]) => entry === true));
};

export const readModeAliases = (value: unknown): Record<string, string> | null => (
  readSharedModeAliases(value)
);

export const readModeSettings = async (homeId: string): Promise<ModeSettingsRead> => {
  const values = await Promise.all([
    getSetting(homeScopedSettingsKey(OPERATING_MODE_SETTING, homeId)),
    getSetting(homeScopedSettingsKey(CAPACITY_PRIORITIES, homeId)),
    getSetting(homeScopedSettingsKey(MODE_DEVICE_TARGETS, homeId)),
    getSetting(CONTROLLABLE_DEVICES),
    getSetting(MANAGED_DEVICES),
    getSetting(BUDGET_EXEMPT_DEVICES),
    getSetting(RESPECT_EXTERNAL_OFF_DEVICES),
    getSetting(DEVICE_START_POLICIES),
    getSetting(TEMPERATURE_CONTROL_DISABLED_DEVICES),
    getSetting(TEMPERATURE_CONTROL_MODES),
    getSetting(NATIVE_EV_WIRING_DEVICES),
    getSetting(homeScopedSettingsKey(MODE_ALIASES, homeId)),
    getSetting(BATTERY_CONTROL_DEVICES),
  ]);
  const [
    mode, priorities, targets, controllables, managed,
    budgetExempt, respectExternalOff, deviceStartPolicies,
    temperatureControlDisabled, temperatureControlModes, nativeWiring, aliases, batteryControl,
  ] = values;
  return {
    mode, priorities, targets, controllables, managed,
    budgetExempt, respectExternalOff, deviceStartPolicies,
    temperatureControlDisabled, temperatureControlModes, nativeWiring, aliases, batteryControl,
  };
};

/**
 * A home battery's Managed map. Never written reads as every battery on. A
 * stored value that does not parse is `unreadable`: the runtime reads it as
 * every battery unmanaged (fail closed), so the UI shows each battery's
 * Managed as off and does not offer the switch until the value is repaired.
 */
export function applyBatteryControlSettings(read: ModeSettingsRead): void {
  if (read.batteryControl === undefined || read.batteryControl === null) {
    state.batteryControl = { status: 'resolved', devices: {} };
    return;
  }
  const devices = parseBatteryControlDevices(read.batteryControl);
  state.batteryControl = devices === null ? { status: 'unreadable' } : { status: 'resolved', devices };
}

/**
 * All-or-nothing, and a rejected read keeps the last good map — the same policy
 * the runtime applies, from the same guard (`isDeviceStartPolicyMap`), so the
 * two can never disagree about what a junk value means. A transient bridge miss
 * must not look like an owner who just cleared every device's policy.
 *
 * Lives beside its sibling reader rather than in `modes.ts`, which sits at its
 * 500-line ceiling.
 */
export function applyDeviceStartPolicySettings(read: ModeSettingsRead): void {
  state.deviceStartPolicyMap = isDeviceStartPolicyMap(read.deviceStartPolicies)
    ? read.deviceStartPolicies
    : state.deviceStartPolicyMap;
}

export function applyTemperatureControlSettings(read: ModeSettingsRead): void {
  state.temperatureControlModes = readTemperatureControlModes(read.temperatureControlModes)
    ?? state.temperatureControlModes;
  state.temperatureControlDisabledMap = temperatureControlDisabledDevices(
    state.temperatureControlModes,
    readStrictBooleanSettingMap(read.temperatureControlDisabled) ?? state.temperatureControlDisabledMap,
  );
}
