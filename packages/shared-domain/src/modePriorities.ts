// Strict ordering for per-mode device priorities.
//
// Priorities are persisted as `Record<mode, Record<deviceId, number>>`. The
// stored payload is untrusted: legacy data, partial saves, or external edits
// can leave two devices sharing the same priority number, gaps in the
// sequence, or non-finite values. Consumers (the planner's shed/restore
// ordering, the settings-UI priority list) need a *strict total order* over the
// configured devices so that one configured device always consistently wins
// over another. (Devices with no stored priority fall to a caller-side default
// and are not ranked here — see TODO.md "default-priority tiebreak".)
//
// This module is the single producer of that strict order. It lives in
// shared-domain because both the runtime (via the settings snapshot builder)
// and the browser settings-UI must resolve priorities the same way, and
// shared-domain is the only layer both may import. Normalization is applied on
// read: the producers never eagerly rewrite settings. (The settings-UI does
// persist the resolved order back through normal user saves, so the strict form
// becomes the stored form over time — that is a side effect of saving, not of
// reading.)

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
