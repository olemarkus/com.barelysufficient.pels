/**
 * Pure device→home membership resolver used for runtime ownership and diagnostics.
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
 * Pure over typed inputs: the setup-layer caller validates the zone tree and
 * persisted config before handing them here — this module never re-validates.
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
 * `setup/homeMembership.ts`, published on `AppContext.homeMembership`).
 * Deliberately EXCLUDES the diagnostics view: `source` is diagnostics/display
 * only, so every ctx consumer sees exactly the provenance-free surface a
 * control path may use. The settings-UI `ui_homes` endpoint reaches the
 * concrete service (with diagnostics) through its own setup-internal seam,
 * never through this port.
 */
export type HomeMembershipPort = {
  /** Resolved home for a device; an unknown device belongs to the main home. */
  getHomeIdForDevice(deviceId: string): HomeId;
  /** `homeId` per snapshot device — no `source`, by design. */
  getMembershipMap(): Readonly<Record<string, HomeId>>;
  /**
   * Producer-resolved source devices that no home may plan or actuate, plus
   * the authority state of Main's persisted selection. Includes the last-good
   * explicit Main meter plus every active sub-home meter.
   */
  getConfiguredMeterSources(): ConfiguredMeterSources;
  hasSubHomes(): boolean;
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
   * watts it governs. `null` identity = the admitted sample's provenance is
   * unknown; never proof of non-collision.
   */
  noteResolvedHomeMeter(deviceId: string | null, sampleAtMs: number): void;
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
