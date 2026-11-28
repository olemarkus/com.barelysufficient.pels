import type { SettingsPort } from '../ports/homeyRuntime';
import { EV_CHARGING_SESSION_SMOOTHING } from '../../packages/shared-domain/src/settings/settingsKeys';
import {
  EV_SMART_TASK_SETTINGS,
  normalizeEvSmartTaskSettings,
} from '../../packages/shared-domain/src/settings/evSmartTaskSettings';
import { isUnknownRecord } from '../../packages/shared-domain/src/recordGuards';
import { readSettingsKeyList } from '../utils/settingsKeyList';

/** Raw map for the owning runtime and browser save boundary; null means unavailable. */
const readEvTaskSetting = (
  settings: Pick<SettingsPort, 'get' | 'getKeys'>,
  key: string,
): Record<string, unknown> | null => {
  try {
    const raw = settings.get(key);
    if (isUnknownRecord(raw)) return raw;
    if (raw != null) return null;
    const keys = readSettingsKeyList(settings);
    return keys.status === 'resolved' && !keys.keys.includes(key) ? {} : null;
  } catch { return null; }
};

export const readEvChargingSessionSmoothingSettings = (settings: Pick<SettingsPort, 'get' | 'getKeys'>) => (
  readEvTaskSetting(settings, EV_CHARGING_SESSION_SMOOTHING)
);

export const readEvSmartTaskSettings = (settings: Pick<SettingsPort, 'get' | 'getKeys'>) => (
  readEvTaskSetting(settings, EV_SMART_TASK_SETTINGS)
);

export const readResolvedEvSmartTaskSettings = (settings: Pick<SettingsPort, 'get' | 'getKeys'>) => {
  const value = readEvSmartTaskSettings(settings);
  return value === null ? null : normalizeEvSmartTaskSettings(value);
};
