/**
 * Zone-tree fetch over the Homey local Web API (`manager/zones/zone`), using
 * the same REST client + auth as the device reads in `managerHomeyApi.ts`.
 *
 * Boundary discipline: the untrusted payload is normalized to a minimal typed
 * tree (`Record<zoneId, { id, name, parent }>`); malformed entries are dropped
 * at this boundary so consumers may assume the typed invariant holds. Any
 * fetch/shape failure resolves to `null` (debug-logged, never thrown outward)
 * so the caller can keep its previously cached tree — the abandon-grace
 * convention for transient external failures (`notes/persisted-settings-state.md`).
 *
 * Consumed by multi-home membership, which joins device `zoneId`s against it
 * (`setup/homeMembership.ts`); until the first tree commits, a pinned sub-home
 * member is held out of actuation. AFTER that first commit an unknown zone is
 * no longer held — it resolves to Main — so the tree rides every snapshot
 * refresh rather than a slower cadence of its own: Homey publishes no zone
 * event, so a stale tree has nothing to correct it. See `TODO.md`.
 */
import type { Logger } from '../../utils/types';
import { isUnknownRecord } from '../../utils/types';
import { normalizeError } from '../../utils/errorUtils';
import { getRawFromHomeyApi } from './managerHomeyApi';

export const ZONES_API_PATH = 'manager/zones/zone';

export type ZoneTreeNode = {
  id: string;
  name: string;
  /** Parent zone id; `null` for the root zone. */
  parent: string | null;
};

/**
 * Minimal typed zone tree keyed by zone id. Dangling parents and multi-node
 * cycles remain representable by design: consumers walking parent chains MUST
 * treat an unknown parent or a revisited node as a broken chain and fail safe
 * (the multi-home membership resolver does — visited-set walk, fallback to
 * the main home).
 */
export type ZoneTree = Record<string, ZoneTreeNode>;

// Keys that collide with Object.prototype machinery. An untrusted zone id —
// or a parent, which consumers use as a record lookup key — matching one of
// these must never enter the tree: `tree['__proto__'] = …` on a plain object
// is prototype pollution, and `tree['constructor']` reads leak prototype
// members.
const DANGEROUS_RECORD_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/** Record-or-array payload tolerance, mirroring `getRawDevices`; junk → null. */
const toRawZoneEntries = (data: unknown): unknown[] | null => {
  if (Array.isArray(data)) return data;
  if (isUnknownRecord(data)) return Object.values(data);
  return null;
};

/** Shape-guard one untrusted zone entry; `null` drops it. */
const toZoneTreeNode = (value: unknown): ZoneTreeNode | null => {
  if (!isUnknownRecord(value)) return null;
  const { id, name, parent } = value;
  if (typeof id !== 'string' || !id || DANGEROUS_RECORD_KEYS.has(id)) return null;
  if (typeof name !== 'string' || !name) return null;
  // A parent that is neither a string nor flat absence is junk — dropping the
  // entry is safer than silently reparenting it to the root. A dangerous
  // record key as parent is the same lookup hazard as a dangerous id.
  if (parent !== null && parent !== undefined && typeof parent !== 'string') return null;
  if (typeof parent === 'string' && DANGEROUS_RECORD_KEYS.has(parent)) return null;
  // Self-parenting is junk identity, not structure — normalize it to a root
  // node so an entry can never claim itself as its own ancestor.
  const parentId = typeof parent === 'string' && parent && parent !== id ? parent : null;
  return { id, name, parent: parentId };
};

/**
 * Fetch and normalize the zone tree. Mirrors `getRawDevices` transport
 * discipline (same REST client, record-or-array payload tolerance) but never
 * throws outward: any failure — including an empty payload or one where every
 * entry is malformed — returns `null` so the caller retains its cached tree.
 */
/*
 * Keeps the INJECTED devices-topic logger rather than a module logger. The root
 * pino logger is created at its default `info` level (`installStructuredLogger`
 * passes no level), so `moduleLogger.debug` here emits nothing in production —
 * it would silently drop every `zone_tree_fetch_failed` / `zone_tree_fetched`
 * record, which are the diagnostics an owner enables the `devices` topic to
 * read. The caller's neighbouring zone logs in `snapshotRefresh` go through the
 * same injected emitter, so this also keeps one zone story on one channel.
 */
export async function fetchZoneTree(params: { logger: Logger }): Promise<ZoneTree | null> {
  const { logger } = params;
  let data: unknown;
  try {
    data = await getRawFromHomeyApi(ZONES_API_PATH);
  } catch (error) {
    logger.debug({
      event: 'zone_tree_fetch_failed',
      reasonCode: 'fetch_failed',
      error: normalizeError(error).message,
    });
    return null;
  }
  const rawEntries = toRawZoneEntries(data);
  if (rawEntries === null) {
    logger.debug({ event: 'zone_tree_fetch_failed', reasonCode: 'invalid_payload' });
    return null;
  }
  // Accumulate on a null-prototype object so a hostile key that slipped a
  // guard could still never reach Object.prototype machinery
  // (defense-in-depth on top of the DANGEROUS_RECORD_KEYS rejection).
  const tree: ZoneTree = Object.create(null) as ZoneTree;
  let droppedEntries = 0;
  for (const entry of rawEntries) {
    const node = toZoneTreeNode(entry);
    if (node) {
      tree[node.id] = node;
    } else {
      droppedEntries += 1;
    }
  }
  // A zone-less Homey cannot exist (there is always a root zone), so BOTH an
  // empty payload and a non-empty payload with no valid entry are a transient
  // quirk / shape change, never truth — treat them as a failed fetch so the
  // cached tree survives.
  if (Object.keys(tree).length === 0) {
    logger.debug({
      event: 'zone_tree_fetch_failed',
      reasonCode: rawEntries.length === 0 ? 'empty_payload' : 'all_entries_malformed',
      droppedEntries,
    });
    return null;
  }
  logger.debug({
    event: 'zone_tree_fetched',
    zonesTotal: Object.keys(tree).length,
    droppedEntries,
  });
  // Materialize as an ordinary record for consumers (`hasOwnProperty` etc.).
  // `Object.fromEntries` defines own data properties, so this re-keying can
  // never trigger prototype setters.
  return Object.fromEntries(Object.entries(tree));
}
