import type { HomeBatteryControlCapability } from '../../contracts/src/types';

/**
 * The line a home battery PELS cannot drive shows where a battery PELS can
 * drive offers its Power-limit control: its Overview card (in its own mode),
 * its device page and its row in the device list. Canonical in
 * `notes/ui-terminology.md` § "Home battery vocabulary".
 */
const BATTERY_WATCH_ONLY_REASON_LINE = 'PELS can only watch it: its app does not accept control';
const BATTERY_OBSERVE_ONLY_REASON_LINE = 'PELS can only watch it: its app does not give Homey control';

/** Why PELS cannot drive this battery, or `null` for one it can (and for a device that is not a battery). */
export const resolveBatteryUndrivableLine = (
  control: HomeBatteryControlCapability | 'not_battery',
): string | null => {
  if (control === 'watch_only') return BATTERY_WATCH_ONLY_REASON_LINE;
  return control === 'observe_only' ? BATTERY_OBSERVE_ONLY_REASON_LINE : null;
};
