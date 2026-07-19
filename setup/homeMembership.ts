import type Homey from 'homey';
import type { Logger as PinoLogger } from '../lib/logging/logger';
import type { ObservedStateEmitter } from '../lib/observer/observedStateEvents';
import {
  MAIN_HOME_ID,
  type DeviceHomeAssignments,
  type DeviceHomeAssignmentsStore,
  type HomeId,
  type HomesStore,
  type SubHomeConfig,
  type ZoneTree,
} from '../lib/home/homeConfig';
import { resolveDeviceHome, type HomeMembership, type HomeMembershipPort } from '../lib/home/membership';
import { normalizeError } from '../lib/utils/errorUtils';
import { DEVICE_HOME_ASSIGNMENTS, HOMES_CONFIG } from '../lib/utils/settingsKeys';
import { createDeviceHomeAssignmentsStore, createHomesStore } from './homeRegistryAdapter';

// Store-key labels for the suspect-warn logs — the canonical settings-key
// constants, so log audits grep the same strings the stores persist under.
type HomeStoreKey = typeof HOMES_CONFIG | typeof DEVICE_HOME_ASSIGNMENTS;

/** One snapshot device as the membership join consumes it. */
export type HomeMembershipDeviceInput = {
  deviceId: string;
  /** The device's Homey zone id, or `null` when unknown. */
  zoneId: string | null;
};

export type HomeMembershipServiceDeps = {
  homesStore: HomesStore;
  assignmentsStore: DeviceHomeAssignmentsStore;
  /** The transport's cached (last-good) zone tree; `null` before the first fetch. */
  getZoneTree: () => ZoneTree | null;
  /** Devices from the latest target snapshot with their zone ids. */
  getDevices: () => readonly HomeMembershipDeviceInput[];
  getLogger: () => PinoLogger | undefined;
  /**
   * Change-gated plan invalidation: fired when a recompute changes the
   * PLAN-RELEVANT membership — the set of non-main assignments (exactly what
   * `filterDevicesForHome` consumes) — so the committed plan never keeps
   * governing the old device set until the next incidental rebuild.
   * Deliberately NARROWER than the log fingerprint: in single-home operation
   * every device is main, so device add/remove churn must stay free here
   * (those rebuilds ride the existing snapshot-refresh paths) — firing on the
   * full map fingerprint would break the no-sub-homes identity. The FIRST
   * resolution never fires (boot builds the initial plan through its own
   * path).
   */
  onMembershipChanged?: () => void;
  /**
   * Fired ONCE, on the false→true `hasSeenZoneTreeCommit` edge (a committed zone
   * tree first lands). The per-home capacity bundles (R7b) gate EXECUTION on
   * that signal; this lets the registry fire each bundle's membership-ready
   * apply-edge the moment execution becomes trustworthy — decoupled from
   * meter-sample arrival (so it works in flow mode too). Contained by the
   * caller; must never throw into `recompute`.
   */
  onZoneTreeCommitReady?: () => void;
};

/**
 * Diagnostics/UI view of the cached membership state. `source` on each entry
 * is DIAGNOSTICS AND DISPLAY ONLY — control paths consume `homeId` alone and
 * must never branch on how it was decided (`lib/home/membership.ts`).
 */
export type HomeMembershipDiagnostics = {
  subHomes: readonly SubHomeConfig[];
  membershipByDeviceId: Readonly<Record<string, HomeMembership>>;
  zoneTree: ZoneTree | null;
  hasSubHomes: boolean;
  /**
   * True while the latest recompute classified either persisted store read
   * (`homes_config` / `device_home_assignments`) as `'suspect'` — the served
   * `subHomes` may then be a stale cache of an unknown persisted truth.
   * DIAGNOSTICS LANE: the settings UI uses it to refuse read-modify-write
   * mutations (a whole-value write composed from a stale cache could erase
   * persisted areas); control paths must not branch on it.
   */
  configDegraded: boolean;
};

/**
 * Cached device→home membership: the stateful join of the homes registry
 * (`HomesStore`), the explicit pins (`DeviceHomeAssignmentsStore`), the
 * transport's zone tree, and each device's snapshot `zoneId`, resolved through
 * the pure `resolveDeviceHome` rule. READ-ONLY over the stores (never writes)
 * and consumer-less on the control path in this PR — `getHomeIdForDevice` /
 * `getMembershipMap` exist for the planner wiring (R5); today only the
 * read-only `ui_homes` endpoint reads the diagnostics view.
 *
 * Recompute is cheap (pure resolver over cached inputs) and never flaps on
 * transient nulls: a `'suspect'` store read keeps the previously cached
 * homes/pins, and a `null` zone tree never overwrites a previously seen tree —
 * before ANY tree has been seen, zone-rule devices resolve via the fail-safe
 * path (main, `source: 'fallback'`), which is the acceptable boot state.
 */
export class HomeMembershipService implements HomeMembershipPort {
  private subHomes: readonly SubHomeConfig[] = [];
  private pins: DeviceHomeAssignments = {};
  private zoneTree: ZoneTree | null = null;
  private membershipByDeviceId: Record<string, HomeMembership> = {};
  // Last-known zoneId per device, from previous COMMITTED snapshots. A
  // fulfilled snapshot whose device entry transiently omits zone must not flap
  // that device to main/'fallback' for one cycle — the previous resolution
  // holds. Bounded by device count: rebuilt from the current snapshot on every
  // recompute, so a device that genuinely left the snapshot is pruned.
  private lastKnownZoneIdByDeviceId: Record<string, string> = {};
  // Devices whose latest resolution used a retained zone — the edge state for
  // the retention debug log (log on ENTRY into retention, re-arm when the zone
  // reappears or the device leaves the snapshot; parity with noteSuspectEdge).
  private retentionLoggedDeviceIds = new Set<string>();
  private suspectByStoreKey: Record<HomeStoreKey, boolean> = {
    [HOMES_CONFIG]: false,
    [DEVICE_HOME_ASSIGNMENTS]: false,
  };
  private lastRecomputeFingerprint: string | null = null;
  private lastPlanRelevantFingerprint: string | null = null;

  constructor(private readonly deps: HomeMembershipServiceDeps) {}

  recompute(): void {
    this.refreshStoreCaches();
    const tree = this.deps.getZoneTree();
    // Never cache null over a previously seen tree: the transport retains
    // last-good, but a recreated transport (or a pre-first-fetch read) reports
    // null — keeping the last seen tree avoids a membership flap to main.
    const hadCommittedTree = this.zoneTree !== null;
    if (tree !== null) this.zoneTree = tree;
    const zoneTreeJustCommitted = !hadCommittedTree && this.zoneTree !== null;
    const nextRetentionLogged = new Set<string>();
    const devices = this.deps.getDevices().map((device) => ({
      deviceId: device.deviceId,
      zoneId: device.zoneId ?? this.retainedZoneIdFor(device.deviceId, nextRetentionLogged),
    }));
    const nextLastKnownZoneIds = Object.fromEntries(devices.flatMap((device) => (
      device.zoneId === null ? [] : [[device.deviceId, device.zoneId] as const]
    )));
    // ALL fallible work (store reads, snapshot read, resolver walks) happens
    // above this line; the membership map is assigned last among it, so a
    // mid-read throw retains the previous membership (the containment
    // invariant in `createHomeMembershipService`). The retention commits after
    // it are pure assignments — they cannot throw and never commit alone.
    // `Object.fromEntries` defines own data properties, so an untrusted device
    // id can never reach Object.prototype machinery here.
    this.membershipByDeviceId = Object.fromEntries(devices.map((device) => [
      device.deviceId,
      resolveDeviceHome({
        zones: this.zoneTree ?? {},
        subHomes: this.subHomes,
        pins: this.pins,
        deviceId: device.deviceId,
        deviceZoneId: device.zoneId,
      }),
    ]));
    this.lastKnownZoneIdByDeviceId = nextLastKnownZoneIds;
    this.retentionLoggedDeviceIds = nextRetentionLogged;
    this.logIfChanged();
    this.notifyIfPlanRelevantMembershipChanged();
    // Fire the execution-readiness edge LAST — after the membership map is
    // committed — so the registry's bundles see fresh membership when they apply.
    if (zoneTreeJustCommitted) this.deps.onZoneTreeCommitReady?.();
  }

  // Retention read for a snapshot entry that omitted its zone. Edge-triggered
  // debug log — on ENTRY into retention only (a persistently zone-omitting
  // device would otherwise log up to twice per refresh cycle, once per
  // recompute trigger); the edge re-arms when the zone reappears or the device
  // leaves the snapshot, because only retention users land in `nextLogged`.
  private retainedZoneIdFor(deviceId: string, nextLogged: Set<string>): string | null {
    if (!Object.hasOwn(this.lastKnownZoneIdByDeviceId, deviceId)) return null;
    const zoneId = this.lastKnownZoneIdByDeviceId[deviceId];
    if (!this.retentionLoggedDeviceIds.has(deviceId)) {
      this.deps.getLogger()?.debug({
        event: 'home_membership_zone_retained',
        deviceId,
        zoneId,
        detail: 'snapshot omitted zone; keeping last-known zone',
      });
    }
    nextLogged.add(deviceId);
    return zoneId;
  }

  /** Resolved home for a device; an unknown device belongs to the main home. */
  getHomeIdForDevice(deviceId: string): HomeId {
    return (Object.hasOwn(this.membershipByDeviceId, deviceId)
      ? this.membershipByDeviceId[deviceId].homeId
      : MAIN_HOME_ID);
  }

  /** Control-path view: `homeId` per device, deliberately without `source`. */
  getMembershipMap(): Readonly<Record<string, HomeId>> {
    return Object.fromEntries(
      Object.entries(this.membershipByDeviceId).map(([deviceId, entry]) => [deviceId, entry.homeId]),
    );
  }

  hasSubHomes(): boolean {
    return this.subHomes.length > 0;
  }

  /**
   * Whether a recompute has adopted a COMMITTED zone tree. `zoneTree` is only
   * ever assigned from a non-null `getZoneTree()` read inside `recompute()`,
   * so this is exactly "membership has resolved against real zone data at
   * least once". The per-home capacity bundles (R7b) gate EXECUTION on this
   * signal: until the tree lands, zone-rule devices resolve to main via the
   * fail-safe path, and a sub-home bundle actuating on that provisional
   * membership could double-control a device main still plans. Fail-closed:
   * false until proven ready.
   */
  hasSeenZoneTreeCommit(): boolean {
    return this.zoneTree !== null;
  }

  getDiagnostics(): HomeMembershipDiagnostics {
    return {
      subHomes: this.subHomes,
      membershipByDeviceId: this.membershipByDeviceId,
      zoneTree: this.zoneTree,
      hasSubHomes: this.hasSubHomes(),
      configDegraded: this.suspectByStoreKey[HOMES_CONFIG]
        || this.suspectByStoreKey[DEVICE_HOME_ASSIGNMENTS],
    };
  }

  // 'present' adopts the normalized value, 'unwritten' is genuinely empty (a
  // fresh install may truthfully have no sub-homes/pins), and 'suspect' keeps
  // the PREVIOUS cache — the persisted truth is unknown, and resolving suspect
  // as empty would flap every device to main on one flaky read.
  private refreshStoreCaches(): void {
    const homesRead = this.deps.homesStore.read();
    if (homesRead.state === 'present') this.subHomes = homesRead.value.subHomes;
    if (homesRead.state === 'unwritten') this.subHomes = [];
    this.noteSuspectEdge(HOMES_CONFIG, homesRead.state === 'suspect');
    const pinsRead = this.deps.assignmentsStore.read();
    if (pinsRead.state === 'present') this.pins = pinsRead.value;
    if (pinsRead.state === 'unwritten') this.pins = {};
    this.noteSuspectEdge(DEVICE_HOME_ASSIGNMENTS, pinsRead.state === 'suspect');
  }

  // Edge-triggered so a persistently suspect store warns once per episode, not
  // once per snapshot refresh.
  private noteSuspectEdge(storeKey: HomeStoreKey, suspect: boolean): void {
    if (suspect && !this.suspectByStoreKey[storeKey]) {
      this.deps.getLogger()?.warn({
        event: 'home_membership_store_read_suspect',
        storeKey,
        detail: 'keeping previously cached value',
      });
    }
    this.suspectByStoreKey[storeKey] = suspect;
  }

  // Change-only info log (order-independent fingerprint): membership changes
  // are rare and operationally interesting; per-recompute logging would spam
  // at snapshot-refresh cadence.
  private logIfChanged(): void {
    const fingerprint = Object.entries(this.membershipByDeviceId)
      .map(([deviceId, entry]) => `${deviceId}=${entry.homeId}:${entry.source}`)
      .sort((a, b) => a.localeCompare(b))
      .join(',');
    if (fingerprint === this.lastRecomputeFingerprint) return;
    this.lastRecomputeFingerprint = fingerprint;
    this.deps.getLogger()?.info({
      event: 'home_membership_recomputed',
      devicesTotal: Object.keys(this.membershipByDeviceId).length,
      subHomesTotal: this.subHomes.length,
      pinsTotal: Object.keys(this.pins).length,
      zoneTreeSeen: this.zoneTree !== null,
    });
  }

  // Plan invalidation gate — see the `onMembershipChanged` dep doc. The
  // fingerprint covers ONLY non-main assignments (the complement the plan
  // filter consumes), so single-home device churn resolves to the same empty
  // fingerprint and stays free. The boot baseline (null → first fingerprint)
  // never fires: the bootstrap builds the initial plan itself, and the plan
  // service may not even exist yet.
  private notifyIfPlanRelevantMembershipChanged(): void {
    const fingerprint = Object.entries(this.membershipByDeviceId)
      .filter(([, entry]) => entry.homeId !== MAIN_HOME_ID)
      .map(([deviceId, entry]) => `${deviceId}=${entry.homeId}`)
      .sort((a, b) => a.localeCompare(b))
      .join(',');
    if (fingerprint === this.lastPlanRelevantFingerprint) return;
    const isFirstResolution = this.lastPlanRelevantFingerprint === null;
    this.lastPlanRelevantFingerprint = fingerprint;
    if (!isFirstResolution) this.deps.onMembershipChanged?.();
  }
}

/** The wired membership service plus the handle that detaches its triggers. */
export type HomeMembershipWiring = {
  service: HomeMembershipService;
  /**
   * Detach every recompute trigger wired by `createHomeMembershipService`
   * (refresh subscription + zone-tree-commit and realtime zone-move
   * callbacks): late dispatches after teardown become no-ops. The
   * settings-change trigger is not wired here — it reads `ctx.homeMembership`
   * lazily and dies when the wiring clears it.
   */
  teardown: () => void;
};

/** The narrow control-path slice of {@link HomeMembershipPort} the complement filter consumes. */
type HomeMembershipControlView = Pick<HomeMembershipPort, 'hasSubHomes' | 'getHomeIdForDevice'>;

/**
 * Membership complement filter for one home's device views — the SINGLE seam
 * shared by the plan input (`buildMainHomeScope.getPlanDevices`) and the
 * sample-pipeline snapshot view (`createHomePowerPipeline`). Consumes ONLY the
 * control-path surface (`hasSubHomes`/`getHomeIdForDevice`) — never the
 * diagnostics view or membership `source` (resolution-in-producer: control
 * paths must not branch on how a membership was decided).
 *
 * Identity guard: with no sub-homes configured (or before the service is
 * wired, e.g. the boot window), the MAIN home gets the SAME array reference —
 * the single-home behavior stays bit-identical.
 *
 * Fail-closed dual (R7b): under those same conditions a SUB-home scope gets an
 * EMPTY list. A sub-home bundle outliving its registry entry (teardown
 * pending) or racing an unwired membership must plan NOTHING — falling through
 * to the full device list would double-control every main device.
 */
export function filterDevicesForHome<T extends { id: string }>(
  membership: HomeMembershipControlView | undefined,
  devices: T[],
  homeId: HomeId,
): T[] {
  if (!membership?.hasSubHomes()) return homeId === MAIN_HOME_ID ? devices : [];
  return devices.filter((device) => membership.getHomeIdForDevice(device.id) === homeId);
}

/**
 * Build the membership service over the real stores and subscribe its
 * recompute to BOTH transport-owned notification seams: the observer emitter's
 * refresh event (dispatched only after a COMMITTED snapshot, so `getDevices`
 * reads the fresh list) and the zone-tree COMMIT callback (the tree rides a
 * DETACHED fetch that lands after the refresh dispatch — without this trigger
 * a successful late commit would wait a full extra refresh cycle to be
 * joined). Runs the initial boot-time recompute (typically: empty snapshot,
 * no tree yet — fail-safe). The `homes_config`/`device_home_assignments`
 * settings-change triggers are wired separately via
 * `SettingsHandlerDeps.recomputeHomeMembership`.
 *
 * CONTAINMENT: both callbacks ride synchronous post-commit chains inside the
 * transport (live-feed tracking, mutation hooks, observation recording share
 * the refresh emit; the tree callback runs on the detached fetch chain), so a
 * recompute throw is caught and logged here, never propagated. `recompute()`
 * assigns its membership map last, so a mid-read throw retains the previous
 * membership.
 */
export const createHomeMembershipService = (params: {
  homey: Homey.App['homey'];
  emitter: ObservedStateEmitter;
  /** The transport's zone-tree-commit seam; called with `undefined` to detach. */
  setOnZoneTreeCommitted: (callback: (() => void) | undefined) => void;
  /**
   * The transport's realtime zone-move seam (a realtime device.update
   * committed a snapshot entry with a changed `zoneId`); called with
   * `undefined` to detach. Without this trigger a realtime zone move would
   * stay unjoined — main-plannable — until the next full refresh.
   */
  setOnDeviceZoneChanged: (callback: (() => void) | undefined) => void;
  getZoneTree: () => ZoneTree | null;
  getDevices: () => readonly HomeMembershipDeviceInput[];
  getLogger: () => PinoLogger | undefined;
  /** See {@link HomeMembershipServiceDeps.onMembershipChanged}. */
  onMembershipChanged?: () => void;
  /** See {@link HomeMembershipServiceDeps.onZoneTreeCommitReady}. */
  onZoneTreeCommitReady?: () => void;
}): HomeMembershipWiring => {
  const service = new HomeMembershipService({
    homesStore: createHomesStore(params.homey),
    assignmentsStore: createDeviceHomeAssignmentsStore(params.homey),
    getZoneTree: params.getZoneTree,
    getDevices: params.getDevices,
    getLogger: params.getLogger,
    onMembershipChanged: params.onMembershipChanged,
    onZoneTreeCommitReady: params.onZoneTreeCommitReady,
  });
  const recomputeContained = (
    trigger: 'startup' | 'snapshot_refresh' | 'zone_tree_commit' | 'realtime_zone_move',
  ): void => {
    try {
      service.recompute();
    } catch (error) {
      params.getLogger()?.error({
        event: 'home_membership_recompute_failed',
        trigger,
        err: normalizeError(error),
      });
    }
  };
  const unsubscribeRefresh = params.emitter.onObservedStateRefresh(() => recomputeContained('snapshot_refresh'));
  params.setOnZoneTreeCommitted(() => recomputeContained('zone_tree_commit'));
  params.setOnDeviceZoneChanged(() => recomputeContained('realtime_zone_move'));
  recomputeContained('startup');
  return {
    service,
    teardown: () => {
      unsubscribeRefresh();
      params.setOnZoneTreeCommitted(undefined);
      params.setOnDeviceZoneChanged(undefined);
    },
  };
};
