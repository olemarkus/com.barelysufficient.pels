import type { ObservedStateOfCharge, StateOfChargeObservedProbe } from '../../packages/contracts/src/types';
import { hasObservedStateOfCharge } from '../../packages/shared-domain/src/stateOfChargeObservedState';
import type { ObservedStateOfChargeRead } from './observedDeviceStateProjection';

/**
 * Projects every device's state of charge to the level — the one thing outside
 * the observation layer answers a question.
 *
 * This exists because the settings-UI payload used to carry the transport's
 * whole working bag: `report`, `capabilityId`, the session pair and `source` all
 * crossed into the WebView, where `report.percent` — the raw carry-forward the
 * observation layer keeps for change detection, which outlives the level it was
 * resolved into — was reachable by anything that narrowed on presence. Reading
 * it as the device's charge showed a departed car's level as "now".
 *
 * Deliberately NOT a field-copy seam like `LIVE_OBSERVED_FIELDS`: copying a
 * field across verbatim is what let the bag through, and a resolved value has to
 * be built rather than forwarded.
 *
 * Applied to EVERY device, not only those the observer has an entry for, so the
 * live path and the stored-parse fallback cannot deliver different shapes.
 *
 * The fallback is why `absent` is consulted rather than obeyed here. An absent
 * read means the OBSERVER has nothing — no projection entry at all (boot, and
 * permanently for an unmanaged picker row, whose rows the projection drops), or
 * an entry carrying no charge. It does not mean the device reports none, so this
 * falls through to the stored parse exactly as the payload's existing rule says
 * ("a field the projection does not carry keeps its stored value") — projected
 * the same way, so a picker row served from its cache is shaped like every other
 * row.
 *
 * Generic over the carrier: this touches `id` and `stateOfCharge` and nothing
 * else, so it takes whatever shape the caller holds rather than naming the
 * settings-UI payload type. An observer file should not have to change because a
 * wire contract did.
 */
export function withResolvedStateOfCharge<T extends { id: string } & StateOfChargeObservedProbe>(
  devices: readonly T[],
  readStateOfCharge: (deviceId: string) => ObservedStateOfChargeRead,
): (Omit<T, 'stateOfCharge'> & { stateOfCharge?: ObservedStateOfCharge })[] {
  return devices.map((device) => {
    const read = readStateOfCharge(device.id);
    if (read.kind === 'observed') return { ...device, stateOfCharge: read.value };
    return hasObservedStateOfCharge(device)
      ? { ...device, stateOfCharge: { level: device.stateOfCharge.level } }
      : device;
  });
}
