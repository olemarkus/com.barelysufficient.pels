import type { SettingsPort } from '../ports/homeyRuntime';
import { readSettingsKeyList } from '../utils/settingsKeyList';

/** Resolve one optional mode setting against Homey's authoritative key list. */
export const readHomeModeSetting = (
  settings: SettingsPort,
  key: string,
): { state: 'resolved'; value: unknown } | { state: 'unavailable' } => {
  try {
    const value = settings.get(key);
    if (value !== undefined && value !== null) return { state: 'resolved', value };
    const keyList = readSettingsKeyList(settings);
    if (keyList.status === 'unavailable') return { state: 'unavailable' };
    if (!keyList.keys.includes(key)) return { state: 'resolved', value: undefined };
    // A listed key with no value is a transient or malformed read. Mode
    // catalog writers never store null, so it cannot be treated as a value.
    return { state: 'unavailable' };
  } catch {
    return { state: 'unavailable' };
  }
};
