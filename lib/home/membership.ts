/**
 * Pure device→home membership resolver. DORMANT until the R4 wiring PR.
 *
 * Rule of record (settled):
 * - A device follows its Homey zone: it belongs to the DEEPEST sub-home whose
 *   root-zone subtree contains the device's zone; outside every sub-home it
 *   belongs to the implicit main home.
 * - An explicit pin ({@link DeviceHomeAssignments}) overrides the zone rule;
 *   pinning to `'main'` opts a device out of a surrounding sub-home.
 * - Fail-safe: a pin to a nonexistent homeId falls back to the zone rule, and
 *   an unknown/missing zone, broken parent chain, or parent cycle resolves to
 *   main — both visibly, as `source: 'fallback'`.
 *
 * Pure over typed inputs: the caller's boundary (R4 wiring) validates the zone
 * tree and config before handing them here — this module never re-validates.
 */

import {
  MAIN_HOME_ID,
  zoneAncestryPath,
  type DeviceHomeAssignments,
  type HomeId,
  type SubHomeConfig,
  type ZoneTree,
} from './homeConfig';

/**
 * How the membership was decided:
 * - `'zone'` — a healthy zone-tree walk (deepest containing sub-home, or main
 *   as the complement).
 * - `'pin'` — an explicit pin to an existing home was honored.
 * - `'fallback'` — a fail-safe path: dangling pin (fell back to the zone
 *   rule), or unusable zone data (missing zone, broken chain, cycle → main).
 *
 * Control decisions consume only `homeId`; `source` is diagnostics and
 * settings-UI display ONLY — consumers must never branch control behaviour on
 * it (the resolution-in-producer rule: provenance stays with the producer).
 */
export type HomeMembershipSource = 'zone' | 'pin' | 'fallback';

/** Resolved membership: which home, and how it was decided. */
export type HomeMembership = {
  homeId: HomeId;
  source: HomeMembershipSource;
};

type ResolveDeviceHomeInput = {
  zones: ZoneTree;
  subHomes: readonly SubHomeConfig[];
  pins: DeviceHomeAssignments;
  deviceId: string;
  /** The device's Homey zone, or `null` when unknown. */
  deviceZoneId: string | null;
};

// Zone-rule outcome: the deepest containing sub-home's id (or main as the
// complement) on a healthy walk, `null` when the zone data is unusable
// (missing zone, broken parent chain, parent cycle) and the caller must
// fail-safe. Deepest-wins: the ancestry path is leaf-first, so the FIRST
// zone on it that is some sub-home's root belongs to the deepest sub-home —
// this holds even for nested roots that v1 validation flags but persisted
// config may still contain. Duplicate roots resolve to the first sub-home in
// config order (deterministic).
const zoneRuleHomeId = (
  zones: ZoneTree,
  subHomes: readonly SubHomeConfig[],
  deviceZoneId: string | null,
): HomeId | null => {
  if (deviceZoneId === null) return null;
  const ancestry = zoneAncestryPath(zones, deviceZoneId);
  if (ancestry === null) return null;
  const homeIdByRootZone = new Map<string, HomeId>();
  for (const subHome of subHomes) {
    if (!homeIdByRootZone.has(subHome.rootZoneId)) {
      homeIdByRootZone.set(subHome.rootZoneId, subHome.homeId);
    }
  }
  for (const zoneId of ancestry) {
    const homeId = homeIdByRootZone.get(zoneId);
    if (homeId !== undefined) return homeId;
  }
  return MAIN_HOME_ID;
};

/** Resolve which home a device belongs to. Pure; see the module doc for the rule. */
export const resolveDeviceHome = (input: ResolveDeviceHomeInput): HomeMembership => {
  const { zones, subHomes, pins, deviceId, deviceZoneId } = input;
  const pin: HomeId | undefined = Object.hasOwn(pins, deviceId) ? pins[deviceId] : undefined;
  if (pin !== undefined) {
    if (pin === MAIN_HOME_ID || subHomes.some((subHome) => subHome.homeId === pin)) {
      return { homeId: pin, source: 'pin' };
    }
    // Dangling pin: fall back to the zone rule, visibly.
    return { homeId: zoneRuleHomeId(zones, subHomes, deviceZoneId) ?? MAIN_HOME_ID, source: 'fallback' };
  }
  const zoneHomeId = zoneRuleHomeId(zones, subHomes, deviceZoneId);
  return zoneHomeId === null
    ? { homeId: MAIN_HOME_ID, source: 'fallback' }
    : { homeId: zoneHomeId, source: 'zone' };
};
