import type { SettingsPort } from '../ports/homeyRuntime';
import { EV_CHARGING_SESSION_SMOOTHING } from '../../packages/shared-domain/src/settings/settingsKeys';
import { isUnknownRecord } from '../../packages/shared-domain/src/recordGuards';
import { readSettingsKeyList } from '../utils/settingsKeyList';

/** Raw map for the owning runtime and browser save boundary; null means unavailable. */
export const readEvChargingSessionSmoothingSettings = (
  settings: Pick<SettingsPort, 'get' | 'getKeys'>,
): Record<string, unknown> | null => {
  try {
    const raw = settings.get(EV_CHARGING_SESSION_SMOOTHING);
    if (isUnknownRecord(raw)) return raw;
    if (raw != null) return null;
    const keys = readSettingsKeyList(settings);
    return keys.status === 'resolved' && !keys.keys.includes(EV_CHARGING_SESSION_SMOOTHING) ? {} : null;
  } catch { return null; }
};
