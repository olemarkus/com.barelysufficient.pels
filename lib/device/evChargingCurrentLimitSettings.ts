import type { EvChargingCurrentLimitsMap, EvChargingCurrentLimits } from '../../packages/contracts/src/types';
import { isEvChargingCurrentLimitsMap } from '../../packages/shared-domain/src/settings/evChargingCurrentLimits';
import type { SettingsPort } from '../ports/homeyRuntime';
import { readSettingsKeyList } from '../utils/settingsKeyList';

/** Boundary state stays with the settings reader; consumers receive a charging policy. */
export type EvChargingCurrentLimitsRead =
  | { state: 'unavailable' }
  | { state: 'resolved'; limits: EvChargingCurrentLimitsMap };

export type EvChargingCurrentPolicy =
  | { kind: 'unrestricted' }
  | { kind: 'limited'; limits: EvChargingCurrentLimits }
  | { kind: 'hold' };

/** A listed unread setting cannot authorize charging without its saved charging range. */
export function readEvChargingCurrentLimitsSetting(
  settings: Pick<SettingsPort, 'get' | 'getKeys'>,
  settingKey: string,
  current: EvChargingCurrentLimitsRead,
): EvChargingCurrentLimitsRead {
  try {
    const raw = settings.get(settingKey);
    if (isEvChargingCurrentLimitsMap(raw)) return { state: 'resolved', limits: raw };
    if (raw === undefined || raw === null) {
      const keys = readSettingsKeyList(settings);
      if (keys.status === 'resolved' && !keys.keys.includes(settingKey)) {
        return { state: 'resolved', limits: {} };
      }
    }
  } catch {
    // A failed or malformed read retains the accepted map, including a saved
    // unrestricted choice. A cold read authorizes no active charging range.
  }
  return current;
}

export function resolveEvChargingCurrentPolicy(
  read: EvChargingCurrentLimitsRead,
  deviceId: string,
): EvChargingCurrentPolicy {
  if (read.state === 'unavailable') return { kind: 'hold' };
  const limits = read.limits[deviceId];
  return limits ? { kind: 'limited', limits } : { kind: 'unrestricted' };
}
