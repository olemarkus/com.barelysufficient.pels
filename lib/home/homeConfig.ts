/**
 * Multi-home configuration domain: types, boundary normalization of the
 * persisted config blobs, v1 config validation, and the typed store ports the
 * settings adapter (`setup/homeRegistryAdapter.ts`) implements.
 *
 * Consumed at runtime by membership, settings, migration, and per-home wiring.
 *
 * Model (settled):
 * - A sub-home is `{homeId, name, rootZoneId, meterDeviceId}`. The main home is
 *   implicit — the sentinel {@link MAIN_HOME_ID} names the complement (every
 *   device not inside any sub-home's root-zone subtree).
 * - `homeId` is `'main'` or a generated stable id. `':'` is FORBIDDEN in ids
 *   (it is the settings-key suffix separator); normalization drops offenders.
 * - Membership resolution lives in `lib/home/membership.ts`.
 *
 * Boundary rule (root AGENTS.md "Validation belongs at the boundary"): the
 * persisted blobs are untrusted input — shape-guard objects, drop malformed
 * entries, and hand only the typed, resolved config inward. Mirrors the
 * `asRecord`/`toFiniteNumber` style of `lib/device/managerEnergy.ts`.
 */

import { randomUUID } from 'node:crypto';
import { isCanonicalHomeyDeviceId } from '../utils/homeyDeviceId';
import { MAIN_HOME_ID, type HomeId } from '../utils/settingsKeys';

/**
 * Home identity, re-exported for domain consumers. Single source of truth in
 * `lib/utils/settingsKeys.ts` (shared with the capacity store in `lib/power`
 * without a peer import): {@link MAIN_HOME_ID} is the sentinel id of the
 * implicit main home (the complement of all sub-homes); {@link HomeId} is
 * `'main'` or a generated sub-home id — never contains `':'`.
 */
export { MAIN_HOME_ID };
export type { HomeId };

/** One Homey zone as the resolver consumes it (typed by the caller's boundary). */
export type ZoneNode = {
  id: string;
  name: string;
  parent: string | null;
};

/** Zone forest keyed by zone id; `parent: null` marks a root. */
export type ZoneTree = Record<string, ZoneNode>;

export type SubHomeConfig = {
  /** Stable generated id; non-empty, never `'main'`, never contains `':'`. */
  homeId: HomeId;
  /** Display name (cosmetic; any string). */
  name: string;
  /** Root of the Homey zone subtree this sub-home spans. */
  rootZoneId: string;
  /** Meter device for this sub-home's own consumption, or `null` when not configured. */
  meterDeviceId: string | null;
};

/**
 * Positive acknowledgement that a persisted homes config may drive the GA
 * multi-home runtime. Pre-GA configs do not carry this field: when the retired
 * `multi_home_enabled` flag was false/absent they must remain inert across the
 * upgrade until an owner deliberately saves an area.
 */
export const HOME_CONFIG_ACTIVATION_VERSION = 1 as const;

/** The persisted multi-home configuration: sub-homes only (main is implicit). */
export type HomeConfig = {
  /** Present after an owner-authored GA upsert or the legacy-true boot migration. */
  activationVersion?: typeof HOME_CONFIG_ACTIVATION_VERSION;
  subHomes: SubHomeConfig[];
};

/**
 * Every configured sub-home meter must have one owner. Routing the same live
 * meter sample into two capacity bundles would make both controllers act on
 * the same measured load while managing different device sets.
 */
export const hasUniqueSubHomeMeters = (
  subHomes: readonly SubHomeConfig[],
): boolean => {
  const assignedMeterIds = subHomes.flatMap(
    ({ meterDeviceId }) => (meterDeviceId === null ? [] : [meterDeviceId]),
  );
  return new Set(assignedMeterIds).size === assignedMeterIds.length;
};

/**
 * Normalize the explicit Main-home meter setting at its settings boundary.
 * `null` means Automatic; padded/empty/non-string values never become a meter
 * identity that can silently miss (or spuriously collide with) a live report.
 */
export const resolveExplicitMainMeterDeviceId = (raw: unknown): string | null => {
  const trimmed = typeof raw === 'string' ? raw.trim() : '';
  return isCanonicalHomeyDeviceId(trimmed) ? trimmed : null;
};

/**
 * Find the sub-home that owns Main's explicitly selected meter, if any. Main's
 * Automatic/combined fallback (`null`) is intentionally outside this identity
 * check; only an explicit device id can be compared across the two stores.
 */
export const findMainMeterCollision = (
  mainMeterDeviceId: string | null,
  subHomes: readonly SubHomeConfig[],
): SubHomeConfig | null => (
  mainMeterDeviceId === null
    ? null
    : subHomes.find(({ meterDeviceId }) => meterDeviceId === mainMeterDeviceId) ?? null
);

/**
 * Explicit device→home pins overriding the zone rule. Absent device = follow
 * its zone. A pin may be `'main'` to opt a device out of a surrounding
 * sub-home. A WELL-FORMED pin to a homeId that no longer exists survives
 * normalization on purpose: existence is the resolver's concern, so the
 * fallback stays visible in the membership result (`source: 'fallback'`).
 */
export type DeviceHomeAssignments = Record<string, HomeId>;

/**
 * Discriminated read result for the home store ports. The three states exist
 * because Homey settings reads can transiently fail and `write()` is
 * WHOLE-VALUE replacement — collapsing them into one empty value would let a
 * read-modify-write flow over one flaky read erase every sub-home/pin:
 * - `'unwritten'` — never written before (no written-before marker): a fresh
 *   install. Mutation flows may write freely.
 * - `'present'` — a plausible persisted blob was read and normalized.
 * - `'suspect'` — the persisted truth is unknown: the store was written
 *   before (marker set) but the blob read back absent, OR the blob was junk
 *   (implausible — regardless of marker), OR the read threw. Mutation
 *   (read-modify-write) flows MUST refuse to write on `'suspect'` and retry
 *   on a later read instead.
 * Precedent: `lib/device/devicePowerCalibrationStore.ts`
 * (`power_calibration_initialized`, notes/persisted-settings-state.md).
 */
export type HomeStoreReadResult<T> =
  | { state: 'unwritten' }
  | { state: 'present'; value: T }
  | { state: 'suspect' };

/**
 * Store port for {@link HomeConfig} (implemented in `setup/homeRegistryAdapter.ts`).
 * `write` replaces the WHOLE persisted value and marks the store
 * written-before; mutation flows MUST refuse to write when `read()` returned
 * `{state: 'suspect'}` — see {@link HomeStoreReadResult}.
 */
export type HomesStore = {
  read(): HomeStoreReadResult<HomeConfig>;
  write(config: HomeConfig): void;
};

/**
 * Store port for {@link DeviceHomeAssignments} (implemented in
 * `setup/homeRegistryAdapter.ts`). `write` replaces the WHOLE persisted value
 * and marks the store written-before; mutation flows MUST refuse to write
 * when `read()` returned `{state: 'suspect'}` — see {@link HomeStoreReadResult}.
 */
export type DeviceHomeAssignmentsStore = {
  read(): HomeStoreReadResult<DeviceHomeAssignments>;
  write(assignments: DeviceHomeAssignments): void;
};

/**
 * Thrown by the store adapters when `write()` refuses an implausible payload
 * (e.g. a sub-home id `'main'`, a `':'`-containing pin): persisting it would
 * only self-classify `'suspect'` on the next read. Nothing is persisted when
 * this is thrown.
 */
export class HomeStoreWriteRefusedError extends Error {
  constructor(storeKey: string) {
    super(`refused to persist an implausible ${storeKey} payload`);
    this.name = 'HomeStoreWriteRefusedError';
  }
}

type UnknownRecord = Record<string, unknown>;

// Arrays are `typeof 'object'` but never a valid record here — rejecting them
// centrally keeps every caller from re-checking (indices would otherwise
// surface as fabricated ids).
const asRecord = (value: unknown): UnknownRecord | null => (
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as UnknownRecord
    : null
);

const toNonEmptyString = (value: unknown): string | null => (
  typeof value === 'string' && value.length > 0 ? value : null
);

// Keys that collide with Object.prototype machinery. An untrusted id keyed
// into a plain record ('__proto__'/'constructor'/'prototype') is malformed by
// definition (device ids are Homey UUIDs, home ids are generated `h_…`), and
// must never survive normalization: Object.fromEntries itself is
// defineProperty-safe, but a surviving dangerous key becomes a live
// prototype-pollution vector for any downstream per-key copy (`obj[k] = v`).
// The membership resolver read-guards with hasOwnProperty; this closes the
// write side. Applied to BOTH untrusted-id namespaces: deviceId record keys
// and homeIds (which key per-home records in the R4 consumers).
const DANGEROUS_RECORD_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

const isSafeUntrustedKey = (key: string): boolean => (
  key.length > 0 && !DANGEROUS_RECORD_KEYS.has(key)
);

/**
 * A sub-home id: non-empty, not the `'main'` sentinel, no `':'` (settings-key
 * separator), and never an Object.prototype-colliding key (home ids key
 * per-home records downstream).
 */
export const isValidSubHomeId = (value: string): boolean => (
  isSafeUntrustedKey(value) && value !== MAIN_HOME_ID && !value.includes(':')
);

// A pin VALUE may additionally be the 'main' sentinel (opt-out of a surrounding sub-home).
const isValidAssignmentHomeId = (value: string): boolean => (
  value === MAIN_HOME_ID || isValidSubHomeId(value)
);

const normalizeSubHome = (raw: unknown): SubHomeConfig | null => {
  const entry = asRecord(raw);
  if (!entry) return null;
  const homeId = toNonEmptyString(entry.homeId);
  if (homeId === null || !isValidSubHomeId(homeId)) return null;
  if (typeof entry.name !== 'string') return null;
  const rootZoneId = toNonEmptyString(entry.rootZoneId);
  if (rootZoneId === null) return null;
  // Absent/malformed meter resolves to flat null (absence, never a fabricated id);
  // a sub-home without a meter still groups devices by zone.
  const meterDeviceId = toNonEmptyString(entry.meterDeviceId);
  return { homeId, name: entry.name, rootZoneId, meterDeviceId };
};

/**
 * Normalize the untrusted persisted `homes_config` blob: drop malformed
 * sub-home entries (bad shape, empty/`'main'`/`':'`-containing ids, missing
 * rootZoneId), keep the good ones, and de-duplicate homeIds first-wins.
 * Duplicate meter ownership is not repaired here: the stricter store boundary
 * rejects that whole blob instead of silently choosing an owner.
 */
export const normalizeHomesConfig = (raw: unknown): HomeConfig => {
  const record = asRecord(raw);
  const rawList = record?.subHomes;
  const entries = Array.isArray(rawList) ? rawList : [];
  const subHomes = entries.flatMap((entry) => {
    const subHome = normalizeSubHome(entry);
    return subHome === null ? [] : [subHome];
  });
  const deduped = subHomes.filter(
    (subHome, index) => subHomes.findIndex((other) => other.homeId === subHome.homeId) === index,
  );
  return {
    ...(record?.activationVersion === HOME_CONFIG_ACTIVATION_VERSION
      ? { activationVersion: HOME_CONFIG_ACTIVATION_VERSION }
      : {}),
    subHomes: deduped,
  };
};

/**
 * Normalize the untrusted persisted `device_home_assignments` blob: keep only
 * string→string entries whose value is a well-formed home id (`'main'` or a
 * valid sub-home id). Pins to a WELL-FORMED but nonexistent homeId are kept —
 * see {@link DeviceHomeAssignments}.
 */
export const normalizeDeviceHomeAssignments = (raw: unknown): DeviceHomeAssignments => {
  const record = asRecord(raw);
  if (!record) return {};
  return Object.fromEntries(
    Object.entries(record).flatMap(([deviceId, homeId]) => (
      isSafeUntrustedKey(deviceId) && typeof homeId === 'string' && isValidAssignmentHomeId(homeId)
        ? [[deviceId, homeId] as const]
        : []
    )),
  );
};

// Entry-level plausibility, deliberately STRICTER than `normalizeSubHome`: any
// field the normalizer would lossily coerce (e.g. a malformed meterDeviceId →
// null) marks the entry implausible instead of silently repaired.
const isPlausibleSubHomeEntry = (raw: unknown): boolean => {
  const entry = asRecord(raw);
  if (!entry) return false;
  const meter = entry.meterDeviceId;
  return typeof entry.homeId === 'string' && isValidSubHomeId(entry.homeId)
    && typeof entry.name === 'string'
    && toNonEmptyString(entry.rootZoneId) !== null
    && (meter === undefined || meter === null || toNonEmptyString(meter) !== null);
};

/**
 * Store-boundary plausibility for the persisted `homes_config` blob, STRICTER
 * than {@link normalizeHomesConfig} (calibration-store precedent): the
 * normalizer is lenient by design (drops bad entries, keeps good ones), but a
 * blob it would lossily change signals partial corruption — classifying it
 * `'present'` would let the next whole-value write persist only the survivors
 * and discard corrupted-but-recoverable entries. Implausible ⇒ the store read
 * classifies `'suspect'`, never a quietly-shrunken config.
 */
export const isPlausibleHomesConfigBlob = (raw: unknown): boolean => {
  const record = asRecord(raw);
  if (!record) return false;
  if (
    record.activationVersion !== undefined
    && record.activationVersion !== HOME_CONFIG_ACTIVATION_VERSION
  ) return false;
  const { subHomes } = record;
  if (!Array.isArray(subHomes) || !subHomes.every(isPlausibleSubHomeEntry)) return false;
  const homeIds = subHomes.flatMap((entry) => {
    const homeId = asRecord(entry)?.homeId;
    return typeof homeId === 'string' ? [homeId] : [];
  });
  return new Set(homeIds).size === subHomes.length
    && hasUniqueSubHomeMeters(normalizeHomesConfig(raw).subHomes);
};

/**
 * Store-boundary plausibility for the persisted `device_home_assignments`
 * blob — same stricter-than-the-normalizer rule as
 * {@link isPlausibleHomesConfigBlob}: any pin
 * {@link normalizeDeviceHomeAssignments} would drop marks the whole blob
 * implausible (`'suspect'` at the store), never a quietly-shrunken record.
 */
export const isPlausibleDeviceHomeAssignmentsBlob = (raw: unknown): boolean => {
  const record = asRecord(raw);
  if (!record) return false;
  return Object.entries(record).every(([deviceId, homeId]) => (
    isSafeUntrustedKey(deviceId) && typeof homeId === 'string' && isValidAssignmentHomeId(homeId)
  ));
};

/**
 * Ancestry path from `zoneId` up to its root, leaf first (`[zoneId, parent,
 * …, root]`). Returns `null` on an unknown zone, a broken parent chain, or a
 * parent cycle — the caller fail-safes (resolver → main; validation → no
 * flag). Iterative with a single visited set: a pathological deep chain must
 * fail safe through the same `null`, never a stack-overflow RangeError. The
 * visited set doubles as the path accumulator (insertion order = walk order,
 * leaf first).
 */
export const zoneAncestryPath = (zones: ZoneTree, zoneId: string): readonly string[] | null => {
  const visited = new Set<string>();
  let currentId: string | null = zoneId;
  while (currentId !== null) {
    if (visited.has(currentId)) return null; // parent cycle
    // Own-key guard: an inherited-property id ('constructor', 'toString', …)
    // must read as an unknown zone, never resolve Object.prototype machinery
    // (mirrors the pins guard in the membership resolver).
    const zone: ZoneNode | undefined = Object.hasOwn(zones, currentId) ? zones[currentId] : undefined;
    if (zone === undefined) return null; // unknown zone / broken parent chain
    visited.add(currentId);
    currentId = zone.parent;
  }
  return [...visited];
};

/** One invalid-for-v1 nesting: `inner`'s root zone lies inside `outer`'s root subtree. */
export type SubHomeRootOverlap = {
  outerHomeId: HomeId;
  innerHomeId: HomeId;
};

/**
 * v1 config validation: sub-home root subtrees must be disjoint. Flags every
 * pair where one sub-home's root zone sits inside another's subtree (identical
 * roots flag once, config-order outer first). Broken/cyclic zone chains never
 * flag — zone-data damage is the resolver's fail-safe, not a config error.
 */
export const findNestedSubHomeRoots = (config: HomeConfig, zones: ZoneTree): SubHomeRootOverlap[] => {
  const ancestryByHomeId = new Map(
    config.subHomes.map((subHome) => [subHome.homeId, zoneAncestryPath(zones, subHome.rootZoneId)]),
  );
  return config.subHomes.flatMap((outer, outerIndex) => config.subHomes.flatMap((inner, innerIndex) => {
    if (outerIndex === innerIndex) return [];
    const innerAncestry = ancestryByHomeId.get(inner.homeId);
    if (!innerAncestry || !innerAncestry.includes(outer.rootZoneId)) return [];
    // Identical roots would match in both directions — report the pair once.
    if (inner.rootZoneId === outer.rootZoneId && outerIndex > innerIndex) return [];
    return [{ outerHomeId: outer.homeId, innerHomeId: inner.homeId }];
  }));
};

const HOME_ID_GENERATION_ATTEMPTS = 32;

/**
 * Generate a short stable sub-home id (`h_` + 8 hex chars, e.g. `h_3f9a1c2e`):
 * never `':'`, never `'main'`, collision-checked against `existingIds`.
 */
export const generateHomeId = (existingIds: readonly HomeId[]): HomeId => {
  const taken = new Set(existingIds);
  for (let attempt = 0; attempt < HOME_ID_GENERATION_ATTEMPTS; attempt += 1) {
    const candidate = `h_${randomUUID().slice(0, 8)}`;
    if (!taken.has(candidate)) return candidate;
  }
  // Practically unreachable (32 collisions on an 8-hex space): fall back to a
  // full UUID, still ':'-free and valid — collision-checked too, so even this
  // path can never return a taken id (one iteration in practice).
  let fallback = `h_${randomUUID()}`;
  while (taken.has(fallback)) fallback = `h_${randomUUID()}`;
  return fallback;
};
