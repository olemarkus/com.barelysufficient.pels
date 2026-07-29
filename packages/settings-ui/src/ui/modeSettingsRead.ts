import {
  BUDGET_EXEMPT_DEVICES,
  CAPACITY_PRIORITIES,
  MODE_ALIASES,
  MODE_DEVICE_TARGETS,
  NATIVE_EV_WIRING_DEVICES,
  OPERATING_MODE_SETTING,
  RESPECT_EXTERNAL_OFF_DEVICES,
  homeScopedSettingsKey,
} from '../../../contracts/src/settingsKeys.ts';
import { getSetting } from './homey.ts';

export type ModeSettingsRead = {
  mode: unknown;
  priorities: unknown;
  targets: unknown;
  controllables: unknown;
  managed: unknown;
  budgetExempt: unknown;
  respectExternalOff: unknown;
  nativeWiring: unknown;
  aliases: unknown;
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

export const readModeAliases = (value: unknown): Record<string, string> => (
  value && typeof value === 'object'
    ? Object.entries(value).reduce<Record<string, string>>((acc, [key, alias]) => (
      typeof key === 'string' && typeof alias === 'string'
        ? { ...acc, [key.toLowerCase()]: alias }
        : acc
    ), {})
    : {}
);

export const readModeSettings = async (homeId: string): Promise<ModeSettingsRead> => {
  const values = await Promise.all([
    getSetting(homeScopedSettingsKey(OPERATING_MODE_SETTING, homeId)),
    getSetting(homeScopedSettingsKey(CAPACITY_PRIORITIES, homeId)),
    getSetting(homeScopedSettingsKey(MODE_DEVICE_TARGETS, homeId)),
    getSetting('controllable_devices'),
    getSetting('managed_devices'),
    getSetting(BUDGET_EXEMPT_DEVICES),
    getSetting(RESPECT_EXTERNAL_OFF_DEVICES),
    getSetting(NATIVE_EV_WIRING_DEVICES),
    getSetting(homeScopedSettingsKey(MODE_ALIASES, homeId)),
  ]);
  const [
    mode, priorities, targets, controllables, managed,
    budgetExempt, respectExternalOff, nativeWiring, aliases,
  ] = values;
  return {
    mode, priorities, targets, controllables, managed,
    budgetExempt, respectExternalOff, nativeWiring, aliases,
  };
};
