/**
 * Pure device→home membership resolver used for runtime ownership and diagnostics.
 *
 * Rule of record (settled):
 * - A device follows its Homey zone: it belongs to the DEEPEST sub-home whose
 *   root-zone subtree contains the device's zone; outside every sub-home it
 *   belongs to the implicit main home.
 * - An explicit pin ({@link DeviceHomeAssignments}) overrides the zone rule;
 *   pinning to `'main'` opts a device out of a surrounding sub-home.
 * - Held out: while meter areas exist, a device whose zone the committed zone
 *   tree does not contain (a zone created after the tree was read) belongs to
 *   NO home until the tree knows the zone. Main would otherwise plan and
 *   actuate it against its own meter while it may sit behind an area's (owner
 *   ruling 2026-10-24). It lists under Main meanwhile.
 * - Fail-safe: a pin to a nonexistent homeId falls back to the zone rule (so
 *   such a device can be held out too), and a missing zone, broken parent
 *   chain, or parent cycle resolves to main — both visibly, as
 *   `source: 'fallback'`. An unknown zone resolves to main the same way while
 *   no meter area exists (every device is Main's then) or before any zone tree
 *   has committed (the actuation fence holds then).
 *
 * Pure over typed inputs: the setup-layer caller validates the zone tree and
 * persisted config before handing them here — this module never re-validates.
 */

import {
  MAIN_HOME_ID,
  zoneAncestryPath,
  type DeviceHomeAssignments,
  type HomeId,
  type MembershipZoneTree,
  type SubHomeConfig,
} from './homeConfig';

/**
 * How the membership was decided:
 * - `'zone'` — a healthy zone-tree walk (deepest containing sub-home, or main
 *   as the complement).
 * - `'pin'` — an explicit pin to an existing home was honored.
 * - `'fallback'` — a fail-safe path: dangling pin (fell back to the zone
 *   rule), or unusable zone data (missing zone, broken chain, cycle → main).
 *   A held-out device lists with this source too.
 *
 * Control decisions consume only `homeId`; `source` is diagnostics and
 * settings-UI display ONLY — consumers must never branch control behaviour on
 * it (the resolution-in-producer rule: provenance stays with the producer).
 */
export type HomeMembershipSource = 'zone' | 'pin' | 'fallback';

/**
 * Resolved membership: the home a device belongs to and how that was decided,
 * or held out of every home for a zone the committed tree lacks (see the
 * module doc).
 */
export type HomeMembership =
  | { state: 'member'; homeId: HomeId; source: HomeMembershipSource }
  | {
    state: 'held_out';
    /** The device's zone, which the committed zone tree does not contain. */
    zoneId: string;
  };

/**
 * Where a membership lists: a member under its own home, a held-out device
 * under Main as a fallback. The view for listings and the `ui_homes`
 * diagnostics; planning and actuation ask whether a device is held out.
 */
export type HomeMembershipListing = {
  homeId: HomeId;
  source: HomeMembershipSource;
};

export const listHomeMembership = (membership: HomeMembership): HomeMembershipListing => (
  membership.state === 'member'
    ? { homeId: membership.homeId, source: membership.source }
    : { homeId: MAIN_HOME_ID, source: 'fallback' }
);

/**
 * Home-membership producer contract for meter-source fencing.
 *
 * Owned by `HomeMembershipService`; consumers must fail closed when authority
 * is unavailable. Governing invariant: `notes/multi-home-model.md`.
 */
export type ConfiguredMeterSources = Readonly<{
  /**
   * `unavailable` means Main's persisted meter selection could not be read
   * authoritatively. Consumers must fail closed even though `deviceIds`
   * retains every last-good source identity the producer still knows.
   */
  state: 'resolved' | 'unavailable';
  deviceIds: ReadonlySet<string>;
}>;

/**
 * Control surface of the cached membership service (implemented by
 * `lib/home/homeMembershipService.ts`, published on `AppContext.homeMembership`).
 * Deliberately EXCLUDES the diagnostics view: `source` is diagnostics/display
 * only, so every ctx consumer sees exactly the provenance-free surface a
 * control path may use. The settings-UI `ui_homes` endpoint reaches the
 * concrete service (with diagnostics) through its own setup-internal seam,
 * never through this port.
 */
export type HomeMembershipPort = {
  /**
   * The home a device lists under: its resolved home, and Main for an unknown
   * device or one held out of every home ({@link isDeviceZoneUnknown}).
   */
  getHomeIdForDevice(deviceId: string): HomeId;
  /**
   * While meter areas run, whether the device's membership resolved as held
   * out: it follows the zone rule and the committed zone tree does not contain
   * its zone yet (it was just moved into a zone created after the tree was
   * read). It lists under Main, but no home plans or actuates it until the
   * tree knows the zone: Main would otherwise control it against the wrong
   * meter (owner ruling 2026-10-24).
   */
  isDeviceZoneUnknown(deviceId: string): boolean;
  /** Listed `homeId` per snapshot device — no `source`, by design. */
  getMembershipMap(): Readonly<Record<string, HomeId>>;
  /**
   * Producer-resolved source devices that no home may plan or actuate, plus
   * the authority state of Main's persisted selection. Includes the last-good
   * explicit Main meter plus every active sub-home meter.
   */
  getConfiguredMeterSources(): ConfiguredMeterSources;
  hasSubHomes(): boolean;
  /** Select controllable members and remove every configured meter source. */
  filterDevicesForHome<T extends { id: string }>(devices: T[], homeId: HomeId): T[];
  /**
   * Positive producer-owned proof that persisted ownership has a trustworthy
   * baseline and, when active sub-homes exist, a committed zone tree.
   */
  isOwnershipReady(): boolean;
  /**
   * True after an ownership settings event has been observed but before its
   * freshly planned generation commits. Consumers must treat cached membership
   * as provisional while this is true.
   */
  hasPendingOwnershipGeneration(): boolean;
  /**
   * True while Main-home ownership is provisional and must not authorize a
   * device write. Producer-resolved so actuator consumers never branch on
   * membership provenance or reconstruct zone-tree readiness themselves.
   */
  isMainHomeActuationFenced(): boolean;
  /**
   * Which meter the whole-home sample the power tracker just ADMITTED came
   * from, stamped with that sample's own ingest timestamp. Called by the
   * power-sample pipeline atomically with ingest — never from a raw read — so
   * the sampled-meter ownership fence can only ever move together with the
   * watts it governs. Always a named meter: a whole-home sample cannot exist
   * without one any more.
   */
  noteResolvedHomeMeter(deviceId: string, sampleAtMs: number): void;
  /**
   * Admit a Flow-card sample after it has replaced the tracker watts. This is
   * the only safe point for a pending Homey-Energy sampled-meter fence to hand
   * control to fresh-plan recovery after a source switch.
   */
  noteAdmittedFlowHomeSample(): void;
  /** Re-resolve from the cached inputs; cheap, never throws destructively. */
  recompute(): void;
};

type ResolveDeviceHomeInput = {
  zones: MembershipZoneTree;
  subHomes: readonly SubHomeConfig[];
  pins: DeviceHomeAssignments;
  deviceId: string;
  /** The device's Homey zone, or `null` when unknown. */
  deviceZoneId: string | null;
};

// Zone-rule outcome: the deepest containing sub-home's id (or main as the
// complement) on a healthy walk; `zone_unknown` when the committed tree does
// not contain the device's zone itself; `unusable` for every other gap (no
// tree yet, no device zone, broken parent chain, parent cycle), where the
// caller must fail-safe. Deepest-wins: the ancestry path is leaf-first, so the
// FIRST zone on it that is some sub-home's root belongs to the deepest
// sub-home — this holds even for nested roots that v1 validation flags but
// persisted config may still contain. Duplicate roots resolve to the first
// sub-home in config order (deterministic).
type ZoneRuleOutcome =
  | { state: 'home'; homeId: HomeId }
  | { state: 'zone_unknown'; zoneId: string }
  | { state: 'unusable' };

const resolveZoneRule = (
  zones: MembershipZoneTree,
  subHomes: readonly SubHomeConfig[],
  deviceZoneId: string | null,
): ZoneRuleOutcome => {
  if (zones.kind === 'pending' || deviceZoneId === null) return { state: 'unusable' };
  const { tree } = zones;
  // Own-key guard, as in `zoneAncestryPath`: an inherited-property id must
  // read as a zone the tree lacks, never as Object.prototype machinery.
  if (!Object.hasOwn(tree, deviceZoneId)) return { state: 'zone_unknown', zoneId: deviceZoneId };
  const ancestry = zoneAncestryPath(tree, deviceZoneId);
  if (ancestry === null) return { state: 'unusable' };
  const homeIdByRootZone = new Map<string, HomeId>();
  for (const subHome of subHomes) {
    if (!homeIdByRootZone.has(subHome.rootZoneId)) {
      homeIdByRootZone.set(subHome.rootZoneId, subHome.homeId);
    }
  }
  for (const zoneId of ancestry) {
    const homeId = homeIdByRootZone.get(zoneId);
    if (homeId !== undefined) return { state: 'home', homeId };
  }
  return { state: 'home', homeId: MAIN_HOME_ID };
};

/** Resolve which home a device belongs to. Pure; see the module doc for the rule. */
export const resolveDeviceHome = (input: ResolveDeviceHomeInput): HomeMembership => {
  const { zones, subHomes, pins, deviceId, deviceZoneId } = input;
  const pin: HomeId | undefined = Object.hasOwn(pins, deviceId) ? pins[deviceId] : undefined;
  if (pin !== undefined && (pin === MAIN_HOME_ID || subHomes.some((subHome) => subHome.homeId === pin))) {
    return { state: 'member', homeId: pin, source: 'pin' };
  }
  // A dangling pin falls back to the zone rule, visibly.
  const zoneRule = resolveZoneRule(zones, subHomes, deviceZoneId);
  if (zoneRule.state === 'home') {
    return { state: 'member', homeId: zoneRule.homeId, source: pin === undefined ? 'zone' : 'fallback' };
  }
  if (zoneRule.state === 'zone_unknown' && subHomes.length > 0) {
    return { state: 'held_out', zoneId: zoneRule.zoneId };
  }
  return { state: 'member', homeId: MAIN_HOME_ID, source: 'fallback' };
};
