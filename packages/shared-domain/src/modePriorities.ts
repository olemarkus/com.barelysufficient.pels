// Strict ordering for per-mode device priorities.
//
// Priorities are persisted as `Record<mode, Record<deviceId, number>>`. The
// stored payload is untrusted: legacy data, partial saves, or external edits
// can leave two devices sharing the same priority number, gaps in the
// sequence, or non-finite values. Consumers (the planner's shed/restore
// ordering, the settings-UI priority list) need a *strict total order* over the
// configured devices so that one configured device always consistently wins
// over another. `normalizeModePriorities` resolves the persisted catalog;
// `rankActiveDevicePriorities` then extends that order across the devices
// present in one home right now, including devices with no stored entry.
//
// This module is the single producer of that strict order. It lives in
// shared-domain because both the runtime (via the settings snapshot builder)
// and the browser settings-UI must resolve priorities the same way, and
// shared-domain is the only layer both may import. Normalization is applied on
// read: reading never rewrites settings. A managed device with no rank gets one
// persisted once, by the home's mode catalog owner when its catalog reloads
// (`lib/home/homeModeCatalog.ts`), so the inferred tail below is only the
// order until that write lands. (The settings-UI also persists the resolved
// order back through normal user saves.)

/** A per-mode map of deviceId -> priority rank (lower wins). */
export type ModePriorityMap = Record<string, number>;

/** All modes' priority maps, keyed by mode name. */
export type ModePriorities = Record<string, ModePriorityMap>;

const coercePriority = (value: unknown): number => (
  // Non-finite / missing priorities sort last, then break by deviceId, so a
  // corrupt entry never silently outranks a real one.
  typeof value === 'number' && Number.isFinite(value) ? value : Number.POSITIVE_INFINITY
);

/**
 * Impose a strict total order on a single mode's device priorities.
 *
 * Returns a map where every device has a unique, gap-free rank in `1..N`.
 * Devices are ordered by their stored priority ascending; ties (and non-finite
 * values) break deterministically by `deviceId` ascending, so the resolved
 * order is independent of the stored object's key order and identical on every
 * read.
 */
export const normalizeModePriorityMap = (raw: Record<string, unknown> | null | undefined): ModePriorityMap => {
  if (!raw || typeof raw !== 'object') return {};
  const ordered = Object.keys(raw).sort((a, b) => {
    const pa = coercePriority(raw[a]);
    const pb = coercePriority(raw[b]);
    // Compare without subtraction: Infinity - Infinity is NaN, which would
    // corrupt the sort and skip the deviceId tiebreak for invalid entries.
    if (pa !== pb) return pa < pb ? -1 : 1;
    if (a === b) return 0;
    return a < b ? -1 : 1;
  });
  const normalized: ModePriorityMap = {};
  ordered.forEach((deviceId, index) => {
    normalized[deviceId] = index + 1;
  });
  return normalized;
};

/**
 * Normalize every mode's priority map to a strict total order. Empty modes are
 * preserved (an empty map stays empty) so mode existence is never lost.
 */
export const normalizeModePriorities = (
  raw: Record<string, Record<string, unknown>> | null | undefined,
): ModePriorities => {
  if (!raw || typeof raw !== 'object') return {};
  const normalized: ModePriorities = {};
  for (const mode of Object.keys(raw)) {
    normalized[mode] = normalizeModePriorityMap(raw[mode]);
  }
  return normalized;
};

/**
 * Resolve the active devices to a strict relative order for one plan cycle.
 *
 * Persisted mode priorities express the owner's preferred order, but they do
 * not necessarily cover the devices that are active now: a newly managed
 * device has no entry yet, while a removed or relocated device may still own a
 * stored rank. This projection ranks only `deviceIds`, closes those active-set
 * gaps, and gives missing/equal/invalid base priorities a deterministic
 * device-id tiebreak. Every returned rank is unique and gap-free in `1..N`.
 */
export const rankActiveDevicePriorities = (
  deviceIds: readonly string[],
  getBasePriority: (deviceId: string) => unknown,
  sortsLastWhenUnranked: (deviceId: string) => boolean = () => false,
): ModePriorityMap => {
  const uniqueDeviceIds = [...new Set(deviceIds)];
  // Read each producer once. Apart from avoiding repeated settings lookups,
  // this makes one projection internally coherent if the outer state changes
  // while a caller is assembling a cycle.
  const basePriorityByDeviceId = new Map(
    uniqueDeviceIds.map((deviceId) => [deviceId, coercePriority(getBasePriority(deviceId))]),
  );
  // Among devices with no usable stored rank, the ones the caller marks (a home
  // battery, whose charging is the owner's natural last choice) go after the
  // rest, so a device added later never sorts below an unplaced battery.
  const unrankedLast = new Set(uniqueDeviceIds.filter((deviceId) => (
    basePriorityByDeviceId.get(deviceId) === Number.POSITIVE_INFINITY && sortsLastWhenUnranked(deviceId)
  )));
  const ordered = uniqueDeviceIds.sort((a, b) => {
    const pa = basePriorityByDeviceId.get(a) ?? Number.POSITIVE_INFINITY;
    const pb = basePriorityByDeviceId.get(b) ?? Number.POSITIVE_INFINITY;
    if (pa !== pb) return pa < pb ? -1 : 1;
    const la = unrankedLast.has(a);
    if (la !== unrankedLast.has(b)) return la ? 1 : -1;
    if (a === b) return 0;
    return a < b ? -1 : 1;
  });
  return Object.fromEntries(ordered.map((deviceId, index) => [deviceId, index + 1]));
};
