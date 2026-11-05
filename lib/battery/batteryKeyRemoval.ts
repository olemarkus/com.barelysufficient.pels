/** The battery owner's hand-back gate before removing the shared Homey API key. */
import type { BatteryControlRead, BatteryKeyRemovalOutcome } from '../ports/batteryControlOwner';
import { getLogger } from '../logging/logger';

const logger = getLogger('battery');

/** Called while the owner holds new app-action claims back until removal settles. */
export async function handBackBeforeKeyRemoval(
  readClaims: () => readonly string[] | undefined,
  release: (deviceId: string) => Promise<boolean>,
  getBattery: (deviceId: string) => BatteryControlRead,
  removeKey: () => void,
): Promise<BatteryKeyRemovalOutcome> {
  const held = readClaims();
  if (held === undefined) {
    logger.warn({ event: 'homey_api_key_removal_refused', deviceIds: 'claim_records_unreadable' });
    return 'claim_records_unreadable';
  }
  await Promise.all(held.map(release));
  // An unresolved recorded target may recover independently of the current
  // inventory. Keep its key until release succeeds; an already missing key
  // is the only case where removing it loses nothing.
  const remaining = readClaims();
  if (remaining === undefined) return 'claim_records_unreadable';
  const left = remaining.filter((id) => {
    const battery = getBattery(id);
    return battery.kind !== 'homey_api_key_missing';
  });
  if (left.length !== 0) {
    logger.warn({ event: 'homey_api_key_removal_refused', deviceIds: left });
    return 'battery_held';
  }
  removeKey();
  return 'removed';
}
