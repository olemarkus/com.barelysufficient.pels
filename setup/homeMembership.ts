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
  private suspectByStoreKey: Record<HomeStoreKey, boolean> = {
    [HOMES_CONFIG]: false,
    [DEVICE_HOME_ASSIGNMENTS]: false,
  };
  private lastRecomputeFingerprint: string | null = null;

  constructor(private readonly deps: HomeMembershipServiceDeps) {}

  recompute(): void {
    this.refreshStoreCaches();
    const tree = this.deps.getZoneTree();
    // Never cache null over a previously seen tree: the transport retains
    // last-good, but a recreated transport (or a pre-first-fetch read) reports
    // null — keeping the last seen tree avoids a membership flap to main.
    if (tree !== null) this.zoneTree = tree;
    // `Object.fromEntries` defines own data properties, so an untrusted device
    // id can never reach Object.prototype machinery here.
    this.membershipByDeviceId = Object.fromEntries(this.deps.getDevices().map((device) => [
      device.deviceId,
      resolveDeviceHome({
        zones: this.zoneTree ?? {},
        subHomes: this.subHomes,
        pins: this.pins,
        deviceId: device.deviceId,
        deviceZoneId: device.zoneId,
      }),
    ]));
    this.logIfChanged();
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

  getDiagnostics(): HomeMembershipDiagnostics {
    return {
      subHomes: this.subHomes,
      membershipByDeviceId: this.membershipByDeviceId,
      zoneTree: this.zoneTree,
      hasSubHomes: this.hasSubHomes(),
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
}

/** The wired membership service plus the handle that detaches its triggers. */
export type HomeMembershipWiring = {
  service: HomeMembershipService;
  /**
   * Detach every recompute trigger wired by `createHomeMembershipService`
   * (refresh subscription + zone-tree-commit callback): late dispatches after
   * teardown become no-ops. The settings-change trigger is not wired here —
   * it reads `ctx.homeMembership` lazily and dies when the wiring clears it.
   */
  teardown: () => void;
};

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
  getZoneTree: () => ZoneTree | null;
  getDevices: () => readonly HomeMembershipDeviceInput[];
  getLogger: () => PinoLogger | undefined;
}): HomeMembershipWiring => {
  const service = new HomeMembershipService({
    homesStore: createHomesStore(params.homey),
    assignmentsStore: createDeviceHomeAssignmentsStore(params.homey),
    getZoneTree: params.getZoneTree,
    getDevices: params.getDevices,
    getLogger: params.getLogger,
  });
  const recomputeContained = (trigger: 'startup' | 'snapshot_refresh' | 'zone_tree_commit'): void => {
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
  recomputeContained('startup');
  return {
    service,
    teardown: () => {
      unsubscribeRefresh();
      params.setOnZoneTreeCommitted(undefined);
    },
  };
};
