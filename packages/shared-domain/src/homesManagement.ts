/**
 * Pure, browser-safe logic for the "Multiple meters" settings surface (the
 * management UI for parts of the home with their own meter): zone-tree walks,
 * the root-zone suggestion for a picked meter, draft validation, and sub-home
 * id generation.
 *
 * Several helpers DUPLICATE `lib/home/homeConfig.ts` (`zoneAncestryPath`, the
 * root-disjointness rule). Accepted duplication across the architecture
 * boundary (root AGENTS.md): the settings UI must not import runtime backend
 * code, and the runtime (`ui_homes_save` endpoint + normalizer + store
 * plausibility gate) remains the enforcement — everything here is UX, not
 * security. Id allocation is NOT duplicated: the save endpoint owns it. Keep
 * the two sides behaviourally aligned when either changes.
 */

import { HOMES_MAIN_HOME_NAME } from './homeNames';
import { foldHomeAreaName } from './homeAreaConfigRules';

/** One Homey zone as the `ui_homes` payload serves it. */
export type HomesZoneNode = {
  id: string;
  name: string;
  /** Parent zone id; `null` for the root zone. */
  parent: string | null;
};

/** Zone forest keyed by zone id. */
export type HomesZoneTree = Record<string, HomesZoneNode>;

/** One configured sub-home as the `ui_homes` payload lists it. */
export type SubHomeListEntry = {
  homeId: string;
  name: string;
  rootZoneId: string;
  meterDeviceId: string | null;
};

/**
 * Ancestry path from `zoneId` up to its root, leaf first (`[zoneId, parent,
 * …, root]`). Returns `null` on an unknown zone, a broken parent chain, or a
 * parent cycle — callers fail safe (no suggestion, no validation flag).
 * Duplicates `zoneAncestryPath` in `lib/home/homeConfig.ts` (see module note).
 */
export const zoneAncestryPath = (
  zones: HomesZoneTree,
  zoneId: string,
): readonly string[] | null => {
  const visited = new Set<string>();
  let currentId: string | null = zoneId;
  while (currentId !== null) {
    if (visited.has(currentId)) return null; // parent cycle
    // Own-key guard: an inherited-property id ('constructor', …) must read as
    // an unknown zone, never resolve Object.prototype machinery.
    const zone: HomesZoneNode | undefined = Object.hasOwn(zones, currentId)
      ? zones[currentId]
      : undefined;
    if (zone === undefined) return null; // unknown zone / broken parent chain
    visited.add(currentId);
    currentId = zone.parent;
  }
  return [...visited];
};

/**
 * Whether `zoneId` sits inside the subtree rooted at `rootZoneId` (root
 * included). `null` = unknown (broken zone chain) — callers must not flag
 * anything on `null`; zone-data damage is never presented as a config problem.
 */
export const isZoneInSubtree = (
  zones: HomesZoneTree,
  zoneId: string,
  rootZoneId: string,
): boolean | null => {
  const path = zoneAncestryPath(zones, zoneId);
  if (path === null) return null;
  return path.includes(rootZoneId);
};

/**
 * Root-zone suggestion for a newly picked meter: from the meter's zone, walk
 * up the zone tree and return the HIGHEST ancestor (nearest the root) whose
 * subtree is disjoint from every `reservedZoneIds` entry — callers pass the
 * OTHER configured homes' meter zones plus their root zones. Disjoint means
 * the candidate's subtree contains no reserved zone AND the candidate is not
 * itself inside a reserved zone's subtree (one-directional containment alone
 * could suggest a zone nested inside another configured home).
 *
 * A zone-forest ROOT never qualifies: a meter area is by definition a strict
 * part of the home, and suggesting the root would swallow the whole home and
 * leave the Main home empty (the degenerate first-area case, where nothing is
 * reserved yet and the literal highest-clean-ancestor walk would reach the
 * root).
 *
 * Returns `null` when no ancestor qualifies (e.g. the meter shares a zone
 * with another home's meter, or sits in the root zone) — the caller then
 * falls back to the meter's own zone as a plain prefill and lets validation
 * speak. Reserved entries with broken ancestry never block (zone-data damage
 * is not a config error — same fail-safe as `lib/home/homeConfig.ts`).
 */
export const suggestSubHomeRootZone = (
  zones: HomesZoneTree,
  meterZoneId: string,
  reservedZoneIds: readonly string[],
): string | null => {
  const meterPath = zoneAncestryPath(zones, meterZoneId);
  if (meterPath === null) return null;
  const reservedSet = new Set(reservedZoneIds);
  const reservedPaths = reservedZoneIds
    .map((zoneId) => zoneAncestryPath(zones, zoneId))
    .filter((path): path is readonly string[] => path !== null);
  const isDisjoint = (candidateIndex: number): boolean => {
    const candidateId = meterPath[candidateIndex];
    if (candidateId === undefined) return false;
    // A forest root never qualifies (see the doc comment): the walk already
    // proved the chain intact, so the node lookup here cannot miss.
    if (zones[candidateId]?.parent === null) return false;
    // (1) subtree(candidate) must contain no reserved zone — the candidate
    // sitting on a reserved zone's ancestry path means it contains that zone.
    if (reservedPaths.some((path) => path.includes(candidateId))) return false;
    // (2) the candidate must not sit inside a reserved zone's subtree — none
    // of its own ancestors (itself included) may be reserved.
    return meterPath.slice(candidateIndex).every((ancestorId) => !reservedSet.has(ancestorId));
  };
  // Walk root-first: the first qualifying candidate in scan order is the
  // highest (nearest-root) one.
  for (let index = meterPath.length - 1; index >= 0; index -= 1) {
    if (isDisjoint(index)) return meterPath[index] ?? null;
  }
  return null;
};

/** One invalid nesting: `inner`'s root zone lies inside `outer`'s root subtree. */
export type SubHomeRootOverlapPair = {
  outerHomeId: string;
  innerHomeId: string;
};

/**
 * Disjointness check over a list of sub-home roots: flags every pair where one
 * root zone sits inside another's subtree (identical roots flag once,
 * list-order outer first). Broken/cyclic zone chains never flag. Duplicates
 * `findNestedSubHomeRoots` in `lib/home/homeConfig.ts` (see module note).
 */
export const findSubHomeRootOverlaps = (
  subHomes: readonly { homeId: string; rootZoneId: string }[],
  zones: HomesZoneTree,
): SubHomeRootOverlapPair[] => {
  const ancestryByHomeId = new Map(
    subHomes.map((subHome) => [subHome.homeId, zoneAncestryPath(zones, subHome.rootZoneId)]),
  );
  return subHomes.flatMap((outer, outerIndex) => subHomes.flatMap((inner, innerIndex) => {
    if (outerIndex === innerIndex) return [];
    const innerAncestry = ancestryByHomeId.get(inner.homeId);
    if (!innerAncestry || !innerAncestry.includes(outer.rootZoneId)) return [];
    // Identical roots would match in both directions — report the pair once.
    if (inner.rootZoneId === outer.rootZoneId && outerIndex > innerIndex) return [];
    return [{ outerHomeId: outer.homeId, innerHomeId: inner.homeId }];
  }));
};

/** The editor's in-progress sub-home; `homeId` is `null` while creating. */
export type SubHomeDraft = {
  homeId: string | null;
  name: string;
  meterDeviceId: string | null;
  rootZoneId: string | null;
};

export type SubHomeDraftError =
  | { kind: 'name_missing' }
  | { kind: 'name_duplicate'; otherName: string }
  | { kind: 'meter_missing' }
  | { kind: 'meter_in_use'; otherName: string }
  | { kind: 'zone_missing' }
  | { kind: 'zone_is_root' }
  | { kind: 'zone_overlap'; otherName: string };

/** Save stays allowed on warnings — they inform, never block. */
export type SubHomeDraftWarning = { kind: 'meter_outside_zone' };

export type SubHomeDraftValidation = {
  errors: SubHomeDraftError[];
  warnings: SubHomeDraftWarning[];
};

// Never collides with real ids (the runtime forbids ':' in sub-home ids).
const DRAFT_PLACEHOLDER_ID = ':draft:';

/**
 * Client-side validation of the editor draft against the CURRENT config list.
 * UX only — the runtime re-validates on write and refuses implausible
 * payloads. Rules: a name (unique among the other homes, case-insensitive),
 * exactly one meter (not another home's), a root zone disjoint from the other
 * homes' root subtrees; the meter sitting outside the chosen subtree is a
 * WARNING, not an error. Zone-data damage (broken chains) never flags.
 */
const validateDraftName = (
  name: string,
  others: readonly SubHomeListEntry[],
): SubHomeDraftError[] => {
  const trimmedName = name.trim();
  if (trimmedName.length === 0) return [{ kind: 'name_missing' }];
  // Same normalized fold as the save seam (NFC + lowercase): an NFC/NFD pair
  // renders identically, so the inline check must refuse what the save would.
  const nameClash = others.find(
    (entry) => foldHomeAreaName(entry.name) === foldHomeAreaName(trimmedName),
  );
  return nameClash === undefined ? [] : [{ kind: 'name_duplicate', otherName: nameClash.name }];
};

const validateDraftMeter = (
  meterDeviceId: string | null,
  others: readonly SubHomeListEntry[],
  mainMeterDeviceId: string | null,
): SubHomeDraftError[] => {
  if (meterDeviceId === null) return [{ kind: 'meter_missing' }];
  if (meterDeviceId === mainMeterDeviceId) {
    return [{ kind: 'meter_in_use', otherName: HOMES_MAIN_HOME_NAME }];
  }
  const meterClash = others.find((entry) => entry.meterDeviceId === meterDeviceId);
  return meterClash === undefined ? [] : [{ kind: 'meter_in_use', otherName: meterClash.name }];
};

const validateDraftZone = (
  draftId: string,
  rootZoneId: string,
  others: readonly SubHomeListEntry[],
  zones: HomesZoneTree,
): SubHomeDraftError[] => {
  // A zone-forest root can never be an area root: it would swallow the whole
  // home and empty the Main home (the strict-subpart invariant — the save
  // endpoint enforces the same rule server-side). An unknown zone id never
  // flags (zone-data damage is not a config error).
  if (Object.prototype.hasOwnProperty.call(zones, rootZoneId) && zones[rootZoneId]?.parent === null) {
    return [{ kind: 'zone_is_root' }];
  }
  const overlaps = findSubHomeRootOverlaps(
    [
      ...others.map(({ homeId, rootZoneId: otherRoot }) => ({ homeId, rootZoneId: otherRoot })),
      { homeId: draftId, rootZoneId },
    ],
    zones,
  );
  const clashingHomeIds = [...new Set(
    overlaps
      .filter((pair) => pair.outerHomeId === draftId || pair.innerHomeId === draftId)
      .map((pair) => (pair.outerHomeId === draftId ? pair.innerHomeId : pair.outerHomeId)),
  )];
  return clashingHomeIds.flatMap((homeId) => {
    const other = others.find((entry) => entry.homeId === homeId);
    return other === undefined ? [] : [{ kind: 'zone_overlap' as const, otherName: other.name }];
  });
};

export const validateSubHomeDraft = (params: {
  draft: SubHomeDraft;
  existing: readonly SubHomeListEntry[];
  zones: HomesZoneTree;
  /** The picked meter's zone when known; `null` disables the subtree warning. */
  meterZoneId: string | null;
  /** Main home's explicit meter; `null` means not chosen yet and cannot identity-clash. */
  mainMeterDeviceId?: string | null;
}): SubHomeDraftValidation => {
  const {
    draft, zones, meterZoneId, mainMeterDeviceId = null,
  } = params;
  const others = params.existing.filter((entry) => entry.homeId !== draft.homeId);
  const errors: SubHomeDraftError[] = [
    ...validateDraftName(draft.name, others),
    ...validateDraftMeter(draft.meterDeviceId, others, mainMeterDeviceId),
    ...(draft.rootZoneId === null
      ? [{ kind: 'zone_missing' as const }]
      : validateDraftZone(draft.homeId ?? DRAFT_PLACEHOLDER_ID, draft.rootZoneId, others, zones)),
  ];
  const warnings: SubHomeDraftWarning[] = draft.rootZoneId !== null && meterZoneId !== null
    && isZoneInSubtree(zones, meterZoneId, draft.rootZoneId) === false
    ? [{ kind: 'meter_outside_zone' }]
    : [];
  return { errors, warnings };
};

/**
 * Live membership preview: how many of the given device zones sit inside the
 * subtree rooted at `rootZoneId` (root included). Devices with unknown zones
 * or broken zone chains are not counted (fail-safe — no claim).
 */
export const countDevicesInZoneSubtree = (
  zones: HomesZoneTree,
  rootZoneId: string,
  deviceZoneIds: readonly (string | null)[],
): number => deviceZoneIds.filter((zoneId) => (
  zoneId !== null && isZoneInSubtree(zones, zoneId, rootZoneId) === true
)).length;

/** Resolved membership entry as `ui_homes` serves it (homeId + resolver source). */
export type PreviewMembershipEntry = {
  homeId: string;
  source: 'zone' | 'pin' | 'fallback';
};

/**
 * Membership-honoring sweep preview: which of the KNOWN devices would belong
 * to an area rooted at `rootZoneId`. Mirrors the resolver's precedence — a
 * pinned device follows its pin (it counts only when pinned into THIS area's
 * `areaHomeId`, i.e. when editing), everything else follows the zone rule
 * (its zone inside the chosen subtree; unknown zones / broken chains never
 * count). Consumes the resolved membership from `ui_homes` joined with the
 * device-zone map, so the preview matches what saving would actually do.
 */
export const previewAreaDeviceCount = (params: {
  zones: HomesZoneTree;
  rootZoneId: string;
  membershipByDeviceId: Readonly<Record<string, PreviewMembershipEntry>>;
  /** Device-id → zone-id lookup (null when the zone is unknown). */
  zoneIdByDeviceId: ReadonlyMap<string, string | null>;
  /** The edited area's id (its pinned-in devices count); null while creating. */
  areaHomeId: string | null;
}): number => Object.entries(params.membershipByDeviceId).filter(([deviceId, entry]) => {
  if (entry.source === 'pin') {
    return params.areaHomeId !== null && entry.homeId === params.areaHomeId;
  }
  const zoneId = params.zoneIdByDeviceId.get(deviceId) ?? null;
  return zoneId !== null && isZoneInSubtree(params.zones, zoneId, params.rootZoneId) === true;
}).length;

/**
 * Whether to prompt for the Main home's own meter: once any meter area exists,
 * only a chosen meter can prove which physical meter belongs to the Main home.
 * Pure display predicate — a UX nudge, never a gate.
 */
export const shouldPromptMainHomeMeter = (params: {
  subHomeCount: number;
  /** Normalized `power_source` setting (`'homey_energy'` / `'flow'`), `null` when unknown. */
  powerSource: string | null;
  /** Normalized `homey_energy_meter_device_id` setting; `null` = not chosen yet. */
  mainMeterDeviceId: string | null;
}): boolean => (
  params.subHomeCount > 0
  && params.powerSource === 'homey_energy'
  && params.mainMeterDeviceId === null
);

/** One zone as the zone picker lists it; `depth` drives the indent. */
export type ZonePickerOption = {
  id: string;
  name: string;
  depth: number;
};

/**
 * Flatten the zone forest for a `<select>`: depth-first from the roots,
 * children sorted by name for a stable order. Orphans (parent id not in the
 * tree) list as roots so damaged zone data never hides a pickable zone; a
 * visited set keeps parent cycles from looping.
 */
export const flattenZoneTreeForPicker = (zones: HomesZoneTree): ZonePickerOption[] => {
  const childrenByParent = new Map<string | null, HomesZoneNode[]>();
  for (const zone of Object.values(zones)) {
    const parentKey = zone.parent !== null && Object.prototype.hasOwnProperty.call(zones, zone.parent)
      ? zone.parent
      : null;
    const siblings = childrenByParent.get(parentKey) ?? [];
    siblings.push(zone);
    childrenByParent.set(parentKey, siblings);
  }
  const options: ZonePickerOption[] = [];
  const visited = new Set<string>();
  const visit = (zone: HomesZoneNode, depth: number): void => {
    if (visited.has(zone.id)) return;
    visited.add(zone.id);
    options.push({ id: zone.id, name: zone.name, depth });
    const children = [...(childrenByParent.get(zone.id) ?? [])]
      .sort((a, b) => a.name.localeCompare(b.name));
    for (const child of children) visit(child, depth + 1);
  };
  const roots = [...(childrenByParent.get(null) ?? [])].sort((a, b) => a.name.localeCompare(b.name));
  for (const root of roots) visit(root, 0);
  return options;
};
