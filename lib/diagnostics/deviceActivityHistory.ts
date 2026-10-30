/** The bounded, observational history of the device presentation sent to owners. */
import type { SettingsUiDeviceActivityEntry } from '../../packages/contracts/src/settingsUi/devices';

export const DEVICE_ACTIVITY_RETENTION_DAYS = 7;
export const DEVICE_ACTIVITY_MAX_ENTRIES = 1000;
export const DEVICE_ACTIVITY_MAX_ENTRIES_PER_DEVICE = 100;
export const DEVICE_ACTIVITY_RETENTION_MS = DEVICE_ACTIVITY_RETENTION_DAYS * 24 * 60 * 60 * 1000;

/** Append-only persistence: a failed read can never turn a later write into a history replacement. */
export type DeviceActivityStore = {
  append(entries: readonly SettingsUiDeviceActivityEntry[], nowMs: number): void;
  read(nowMs: number): SettingsUiDeviceActivityEntry[];
};

/** Also bounds the retry queue and the merge of stored and not-yet-stored observations. */
export const retainDeviceActivity = (
  entries: readonly SettingsUiDeviceActivityEntry[], nowMs: number,
): SettingsUiDeviceActivityEntry[] => {
  const counts = new Map<string, number>();
  const ids = new Set<string>();
  return [...entries].sort((a, b) => b.atMs - a.atMs || b.id.localeCompare(a.id)).filter((entry) => {
    if (ids.has(entry.id) || entry.atMs < nowMs - DEVICE_ACTIVITY_RETENTION_MS) return false;
    ids.add(entry.id);
    const count = counts.get(entry.deviceId) ?? 0;
    if (count >= DEVICE_ACTIVITY_MAX_ENTRIES_PER_DEVICE) return false;
    counts.set(entry.deviceId, count + 1);
    return true;
  }).slice(0, DEVICE_ACTIVITY_MAX_ENTRIES);
};
