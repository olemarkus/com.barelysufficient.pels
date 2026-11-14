import type { HomeBatteryControlCapability } from '../../contracts/src/types';

/**
 * The line a home battery PELS cannot drive shows where a battery PELS can
 * drive offers its Power-limit control: its Overview card (in its own mode),
 * its device page and its row in the device list. Canonical in
 * `notes/ui-terminology.md` § "Home battery vocabulary".
 */
const BATTERY_WATCH_ONLY_REASON_LINE = 'PELS can only watch it: its app does not accept control';
const BATTERY_OBSERVE_ONLY_REASON_LINE = 'PELS can only watch it: its app does not give Homey control';
const BATTERY_NOT_REPORTING_REASON_LINE = 'PELS can only watch it: its app reports no readings from the battery';
const BATTERY_NEEDS_LOCAL_API_REASON_LINE = 'PELS can only watch it: '
  + 'turn on the battery\'s Local API so its app reports it';
const BATTERY_THROUGH_LOCAL_DEVICE_REASON_LINE = 'PELS can only watch this device: '
  + 'PELS controls this battery through its local network device';
const BATTERY_NEEDS_API_KEY_REASON_LINE = 'PELS can only watch it: add a Homey API key '
  + 'so it can help with your limit and solar';

/** Why PELS cannot drive this battery, or `null` for one it can (and for a device that is not a battery). */
export const resolveBatteryUndrivableLine = (
  control: HomeBatteryControlCapability | 'not_battery',
): string | null => {
  if (control === 'watch_only') return BATTERY_WATCH_ONLY_REASON_LINE;
  if (control === 'needs_homey_api_key') return BATTERY_NEEDS_API_KEY_REASON_LINE;
  if (control === 'not_reporting') return BATTERY_NOT_REPORTING_REASON_LINE;
  if (control === 'needs_local_api') return BATTERY_NEEDS_LOCAL_API_REASON_LINE;
  if (control === 'controlled_through_local_device') return BATTERY_THROUGH_LOCAL_DEVICE_REASON_LINE;
  return control === 'observe_only' ? BATTERY_OBSERVE_ONLY_REASON_LINE : null;
};
