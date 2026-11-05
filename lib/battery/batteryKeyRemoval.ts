/** The battery owner's hand-back gate before removing the shared Homey API key. */
import type { BatteryControlRead, BatteryKeyRemovalOutcome } from '../ports/batteryControlOwner';
import { getLogger } from '../logging/logger';
import { canRunAppActionHandBack } from './batteryClaimStanding';

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
  // An unobserved battery may still need this key once its first read arrives.
  // Only a resolved inability to use the key makes removal lose nothing.
  const remaining = readClaims();
  if (remaining === undefined) return 'claim_records_unreadable';
  const left = remaining.filter((id) => {
    const battery = getBattery(id);
    return battery.kind === 'unobserved' || canRunAppActionHandBack(battery);
  });
  if (left.length !== 0) {
    logger.warn({ event: 'homey_api_key_removal_refused', deviceIds: left });
    return 'battery_held';
  }
  removeKey();
  return 'removed';
}
