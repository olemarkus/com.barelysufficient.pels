import { state } from './state.ts';

/**
 * Whether a device has been given a place in a mode's priority order.
 *
 * Membership, not magnitude. The catalog in `state` has already been through
 * `normalizeModePriorities`, which ranks the devices that HAVE an entry `1..N`;
 * a device nobody placed simply has none. It is not outside the order: the
 * runtime sorts it LAST and breaks ties by device id, so it is limited first, in
 * an order nobody chose.
 */
export const hasPlaceInOrder = (priority: unknown): boolean => (
  typeof priority === 'number' && Number.isFinite(priority)
);

export const countUnplacedDevices = (deviceIds: readonly string[], mode: string): number => {
  const placed = state.capacityPriorities[mode] ?? {};
  return deviceIds.filter((id) => !hasPlaceInOrder(placed[id])).length;
};
