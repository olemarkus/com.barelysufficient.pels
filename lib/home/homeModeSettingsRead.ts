import type { SettingsPort } from '../ports/homeyRuntime';

/** Resolve one optional mode setting against Homey's authoritative key list. */
export const readHomeModeSetting = (
  settings: SettingsPort,
  key: string,
): { state: 'resolved'; value: unknown } | { state: 'unavailable' } => {
  try {
    const value = settings.get(key);
    if (value !== undefined && value !== null) return { state: 'resolved', value };
    const keys = settings.getKeys() as unknown;
    if (!Array.isArray(keys) || keys.length === 0 || !keys.every((entry) => typeof entry === 'string')) {
      return { state: 'unavailable' };
    }
    if (!keys.includes(key)) return { state: 'resolved', value: undefined };
    // A listed key with no value is a transient or malformed read. Mode
    // catalog writers never store null, so it cannot be treated as a value.
    return { state: 'unavailable' };
  } catch {
    return { state: 'unavailable' };
  }
};
