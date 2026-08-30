import type Homey from 'homey';
import type { Logger as PinoLogger } from '../lib/logging/logger';
import type { ObservedStateEmitter } from '../lib/observer/observedStateEvents';
import type { MainMeterSelection } from '../packages/contracts/src/mainMeterSelection';
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
import type { HomeMeterArrangementObservation } from '../lib/device/transport/managerFetch';
import { normalizeError } from '../lib/utils/errorUtils';
import {
  DEVICE_HOME_ASSIGNMENTS,
  HOMES_CONFIG,
} from '../lib/utils/settingsKeys';
import { createDeviceHomeAssignmentsStore, createHomesStore } from './homeRegistryAdapter';
import {
  isHomeConfigRuntimeActive,
  readLegacyMultiHomeEnabled,
} from './multiHomeActivation';
import { readMainMeterSelection } from './mainMeterSettings';
import {
  MainMeterAuthority,
  type MainMeterAuthorityContext,
} from './homeMainMeterAuthority';
import {
  readConfiguredPowerSource,
  type ConfiguredPowerSourceRead,
} from './powerSourceSettings';

// Store-key labels for the suspect-warn logs — the canonical settings-key
// constants, so log audits grep the same strings the stores persist under.
type HomeStoreKey = typeof HOMES_CONFIG | typeof DEVICE_HOME_ASSIGNMENTS;
export type OwnershipGenerationPreparationState = 'ready' | 'retry' | 'blocked';

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
   * Semantic Main-meter selection, normalized at the settings boundary.
   * `unavailable` is a domain authority state; raw SDK values/errors never
   * cross this seam.
   */
  getMainMeterSelection: () => MainMeterSelection;
  /**
   * Semantic active power source. Omitted only by direct service tests, which
   * model the historical Homey Energy path by default.
   */
  getConfiguredPowerSource?: () => ConfiguredPowerSourceRead;
  /**
   * Ingest stamp of the whole-home sample the MAIN power tracker currently
   * serves. Consulted only until this process admits its first sample, so it
   * answers exactly "what did the restart hand us?": the tracker reloads
   * durable watts across a restart, but nothing reloads the meter identity that
   * governed them, and the sampled clause must fence rather than read that gap
   * as proof of a clean sample. Omitted by direct service tests, which model a
   * process that has never persisted a sample.
   */
  getRestoredSampleAtMs?: () => number | undefined;
  /**
   * Boot-latched positive evidence from the retired pre-GA flag. Never read
   * fresh per recompute: a transient settings miss must not deactivate a
   * running set of homes.
   */
  legacyMultiHomeEnabled: boolean;
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
   * Fired whenever the producer-resolved runtime activation posture changes.
   * This is deliberately independent of the plan-membership fingerprint: a
   * held→active config with zero currently assigned devices still needs its
   * per-home meter runtimes reconciled.
   */
  onRuntimeActiveChanged?: (runtimeActive: boolean) => void;
  /**
   * Fired on each false→true Main ownership-readiness edge. Separate from the
   * membership fingerprint: a suspect baseline can recover without changing
   * the resolved map, but Main still needs to rebuild + reconcile the plan it
   * previously committed behind the actuation fence.
   */
  onMainOwnershipReady?: () => void;
  /**
   * Fired when a point-of-use Main meter read cannot prove ownership. The
   * wiring uses this to schedule a bounded re-probe/rebuild/reconcile path, so
   * flow mode does not depend on a future sample or settings event to reopen
   * the transient fence.
   */
  onMainAuthorityUnresolved?: () => void;
  /**
   * Fired when the SAMPLED-meter clause stops fencing Main (blocked→ready) —
   * usually the poll simply resolved a different `cumulative` item, with no
   * settings event; the first admitted Flow sample after a source switch
   * settles the same debt once it has replaced the old Homey-Energy watts.
   * Without this the committed plan keeps whatever sheds it planned behind
   * the closed write seam and never actuates them (stable-plan actuation does
   * not cover sheds). See
   * {@link MainMeterAuthorityDeps.onSampledAuthorityReopened}.
   */
  onMainAuthorityReopened?: () => void;
  /**
   * Fired synchronously after the first trustworthy ownership map commits but
   * before any membership-driven plan rebuild starts. Consumers that deferred
   * persisted classification while ownership was provisional can retry here,
   * so the rebuild observes the repaired settings.
   */
  onOwnershipReadyBeforePlanWork?: (
    membership: HomeMembershipService,
    allowPendingOwnershipGeneration: boolean,
  ) => void;
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
   * Producer-resolved activation posture for the saved meter-area config.
   * The settings UI uses this to avoid presenting held legacy configuration
   * as live control; consumers must not re-resolve the legacy flag.
   */
  runtimeActive: boolean;
  /**
   * The last PROVEN answer to "can the whole-home meter be named?", latched
   * from the transport's per-read observation (`onHomeMeterArrangement`).
   * `unknown` until a read proves either way (boot, flow source). CONFIG
   * SURFACE ONLY: the save seam uses `idless_aggregate_only` to give an
   * id-less-aggregate home an honest refusal instead of a remedy its picker
   * can never satisfy; control paths must not branch on it.
   */
  mainMeterArrangement: 'unknown' | 'identified' | 'idless_aggregate_only';
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
 * the pure `resolveDeviceHome` rule. This produces both control routing
 * (`getHomeIdForDevice` / `getMembershipMap`) and the read-only `ui_homes`
 * diagnostics. While a legacy config is held, control resolves every device
 * to Main home while diagnostics keep the saved config visible for deliberate
 * activation.
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
  // Positive boot baseline. Constructor defaults (`[]` / `{}`) are safe
  // storage, not evidence: a FIRST suspect read must never authorize either
  // Main or a sub-home controller against fabricated empty ownership.
  private hasSeenNonSuspectReadByStoreKey: Record<HomeStoreKey, boolean> = {
    [HOMES_CONFIG]: false,
    [DEVICE_HOME_ASSIGNMENTS]: false,
  };
  // Control-path gate, resolved at the same producer that adopts homes_config.
  // Diagnostics retain the configured homes/membership while false so the
  // existing Edit → Save action can explicitly activate a held legacy config.
  private runtimeActive = false;
  private lastNotifiedRuntimeActive = false;

  /** Last proven meter-arrangement observation; see the diagnostics field doc. */
  private mainMeterArrangement: 'unknown' | 'identified' | 'idless_aggregate_only' = 'unknown';

  private lastRecomputeFingerprint: string | null = null;
  private lastPlanRelevantFingerprint: string | null = null;

  /**
   * Single owner of the power-source / configured-meter / sampled-meter authority
   * question, including its edge-trigger latches. Kept in one place because all
   * three answers share the same two settings reads and the same collision
   * predicate; split apart, the sampled check had to re-read what its caller had
   * just resolved, and `readMainMeterSelection` is side-effecting.
   */
  private readonly meterAuthority: MainMeterAuthority;
  // Settings events close the controller authority synchronously, before the
  // serialized settings handler can run. The observed generation is committed
  // only by the owned recovery after semantic recompute + fresh plan builds;
  // rapid events therefore cannot let an intermediate continuation reopen.
  private observedOwnershipGeneration = 0;
  private committedOwnershipGeneration = 0;
  private applyingOwnershipGeneration: {
    generation: number;
    previousCommittedGeneration: number;
  } | null = null;

  constructor(private readonly deps: HomeMembershipServiceDeps) {
    // Assigned here, not as a field initializer: `deps` is a constructor
    // parameter property and is not initialized when field initializers run.
    this.meterAuthority = new MainMeterAuthority({
      getLogger: () => this.deps.getLogger(),
      getMainMeterSelection: () => this.deps.getMainMeterSelection(),
      ...(this.deps.getConfiguredPowerSource === undefined
        ? {}
        : { getConfiguredPowerSource: this.deps.getConfiguredPowerSource }),
      ...(this.deps.getRestoredSampleAtMs === undefined
        ? {}
        : { getRestoredSampleAtMs: this.deps.getRestoredSampleAtMs }),
      ...(this.deps.onMainAuthorityUnresolved === undefined
        ? {}
        : { onMainAuthorityUnresolved: this.deps.onMainAuthorityUnresolved }),
      ...(this.deps.onMainAuthorityReopened === undefined
        ? {}
        : { onSampledAuthorityReopened: this.deps.onMainAuthorityReopened }),
    });
  }

  recompute(): void {
    const mainOwnershipWasReady = this.isOwnershipReady();
    const subHomeExecutionWasReady = this.isSubHomeExecutionReady();
    this.refreshStoreCaches();
    const tree = this.deps.getZoneTree();
    // Never cache null over a previously seen tree: the transport retains
    // last-good, but a recreated transport (or a pre-first-fetch read) reports
    // null — keeping the last seen tree avoids a membership flap to main.
    if (tree !== null) this.zoneTree = tree;
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
    const ownershipBecameReady = !mainOwnershipWasReady
      && this.isOwnershipReady()
      && !this.hasPendingOwnershipGeneration();
    // This producer has just committed the first trustworthy device→home map.
    // Retry deferred persistent classification BEFORE plan invalidation reads
    // those settings; the later execution-readiness callback remains last.
    if (ownershipBecameReady) {
      this.retryDeferredSeedBeforeInitialPlanWork();
    }
    this.logIfChanged();
    this.notifyIfPlanRelevantMembershipChanged();
    if (this.runtimeActive !== this.lastNotifiedRuntimeActive) {
      this.lastNotifiedRuntimeActive = this.runtimeActive;
      this.deps.onRuntimeActiveChanged?.(this.runtimeActive);
    }
    if (ownershipBecameReady) {
      this.deps.onMainOwnershipReady?.();
    }
    // Fire the execution-readiness edge LAST — after the membership map is
    // committed — so the registry's bundles see fresh membership when they apply.
    if (!subHomeExecutionWasReady && this.isSubHomeExecutionReady()) {
      this.deps.onZoneTreeCommitReady?.();
    }
  }

  private retryDeferredSeedBeforeInitialPlanWork(): void {
    try {
      this.deps.onOwnershipReadyBeforePlanWork?.(this, false);
    } catch (error: unknown) {
      // Classification settings are an external boundary. Their failure must
      // not consume the one-shot readiness edges; publish readiness and let
      // the owned recovery retry the seed before its next plan build.
      this.deps.getLogger()?.error({
        event: 'home_ownership_seed_retry_failed',
        err: normalizeError(error),
      });
      this.deps.onMainAuthorityUnresolved?.();
    }
  }

  // Retention read for a snapshot entry that omitted its zone. Edge-triggered
  // debug log — on ENTRY into retention only (a persistently zone-omitting
  // device would otherwise log up to twice per refresh cycle, once per
  // recompute trigger); the edge re-arms when the zone reappears or the device
  // leaves the snapshot, because only retention users land in `nextLogged`.
  private retainedZoneIdFor(deviceId: string, nextLogged: Set<string>): string | null {
    const zoneId = this.lastKnownZoneIdByDeviceId[deviceId];
    if (zoneId === undefined) return null;
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
    if (!this.runtimeActive) return MAIN_HOME_ID;
    return this.membershipByDeviceId[deviceId]?.homeId ?? MAIN_HOME_ID;
  }

  /** Control-path view: `homeId` per device, deliberately without `source`. */
  getMembershipMap(): Readonly<Record<string, HomeId>> {
    if (!this.runtimeActive) return {};
    return Object.fromEntries(
      Object.entries(this.membershipByDeviceId).map(([deviceId, entry]) => [deviceId, entry.homeId]),
    );
  }

  /**
   * Meter identity is source ownership, independent of device membership. A
   * meter outside its area's zone may resolve to Main, but it remains a source
   * device and must never enter any home's controllable set.
   */
  getConfiguredMeterSources(): ReturnType<HomeMembershipPort['getConfiguredMeterSources']> {
    return this.meterAuthority.getConfiguredMeterSources(this.authorityContext());
  }

  private authorityContext(): MainMeterAuthorityContext {
    return { runtimeActive: this.runtimeActive, subHomes: this.subHomes };
  }

  /** Admitted-ingest push seam: which meter the tracker's sample came from. */
  noteResolvedHomeMeter(deviceId: string | null, sampleAtMs: number): void {
    this.meterAuthority.noteResolvedHomeMeter(deviceId, sampleAtMs, this.authorityContext());
  }

  /** Admitted Flow sample: the tracker no longer serves retained meter watts. */
  noteAdmittedFlowHomeSample(): void {
    this.meterAuthority.noteAdmittedFlowHomeSample();
  }

  /**
   * Read push seam (`onHomeMeterArrangement`): whether the whole-home meter
   * can be named. Latches the last PROVEN observation; `unproven` (an SDK miss
   * or an ambiguous multi-cumulative pick) never overwrites it — a transient
   * failure must not select, nor deselect, the unnameable-meter refusal.
   */
  noteHomeMeterArrangement(observation: HomeMeterArrangementObservation): void {
    if (observation === 'unproven') return;
    this.mainMeterArrangement = observation;
  }

  hasSubHomes(): boolean {
    return this.runtimeActive && this.subHomes.length > 0;
  }

  /**
   * Ownership is usable only after BOTH persisted stores have produced a
   * non-suspect baseline. Active sub-homes additionally require a committed
   * zone tree; a resolved single-home/held config needs no tree because every
   * device honestly belongs to Main.
   */
  isOwnershipReady(): boolean {
    const storesReady = this.hasSeenNonSuspectReadByStoreKey[HOMES_CONFIG]
      && this.hasSeenNonSuspectReadByStoreKey[DEVICE_HOME_ASSIGNMENTS];
    if (!storesReady) return false;
    return !this.runtimeActive || this.subHomes.length === 0 || this.zoneTree !== null;
  }

  /**
   * Synchronous ownership-settings edge. This does not alter durable
   * membership/readiness (smart-task lifecycle may keep trusting the last
   * committed map), but it immediately fences every controller generation.
   */
  observeOwnershipConfigurationChanged(): void {
    this.observedOwnershipGeneration += 1;
    this.deps.onMainAuthorityUnresolved?.();
  }

  getObservedOwnershipGeneration(): number {
    return this.observedOwnershipGeneration;
  }

  hasPendingOwnershipGeneration(): boolean {
    return this.committedOwnershipGeneration !== this.observedOwnershipGeneration;
  }

  /**
   * Semantic preparation result for the owned recovery. `retry` covers
   * transient/unproven authority; `blocked` is a durable explicit-meter
   * collision that waits for a newer settings event rather than polling.
   */
  classifyOwnershipGenerationForPreparation(
    generation: number,
  ): OwnershipGenerationPreparationState {
    if (generation !== this.observedOwnershipGeneration) return 'retry';
    if (
      this.suspectByStoreKey[HOMES_CONFIG]
      || this.suspectByStoreKey[DEVICE_HOME_ASSIGNMENTS]
      || !this.isOwnershipReady()
    ) return 'retry';
    if (!this.runtimeActive || this.subHomes.length === 0) return 'ready';
    return this.meterAuthority.resolveForCommit(this.authorityContext());
  }

  /**
   * Commit only the still-current, fully prepared generation. The caller has
   * already committed fresh Main/sub-home plans while the final actuator seams
   * were closed; opening here authorizes their reconcile and nothing older.
   */
  commitPreparedOwnershipGeneration(generation: number): boolean {
    if (!this.beginPreparedOwnershipGenerationApplication(generation)) return false;
    return this.completePreparedOwnershipGenerationApplication(generation);
  }

  /**
   * Temporarily open the freshly prepared generation so its reconcile can
   * actuate. The owner must complete or abort this transaction; abort restores
   * the previous committed generation and closes every controller again.
   */
  beginPreparedOwnershipGenerationApplication(generation: number): boolean {
    if (this.classifyOwnershipGenerationForPreparation(generation) !== 'ready') return false;
    if (this.applyingOwnershipGeneration !== null) return false;
    this.applyingOwnershipGeneration = {
      generation,
      previousCommittedGeneration: this.committedOwnershipGeneration,
    };
    this.committedOwnershipGeneration = generation;
    return true;
  }

  completePreparedOwnershipGenerationApplication(generation: number): boolean {
    const applying = this.applyingOwnershipGeneration;
    if (
      applying?.generation !== generation
      || this.committedOwnershipGeneration !== generation
      || this.observedOwnershipGeneration !== generation
    ) return false;
    this.applyingOwnershipGeneration = null;
    return true;
  }

  abortPreparedOwnershipGenerationApplication(generation: number): void {
    const applying = this.applyingOwnershipGeneration;
    if (applying?.generation !== generation) return;
    if (this.committedOwnershipGeneration === generation) {
      this.committedOwnershipGeneration = applying.previousCommittedGeneration;
    }
    this.applyingOwnershipGeneration = null;
  }

  /**
   * Apply-edge readiness for sub-home runtimes. Unlike general ownership
   * readiness, this always requires a committed tree; the callback historically
   * represents that edge even when the registry currently has zero bundles.
   */
  isSubHomeExecutionReady(): boolean {
    const storesReady = this.hasSeenNonSuspectReadByStoreKey[HOMES_CONFIG]
      && this.hasSeenNonSuspectReadByStoreKey[DEVICE_HOME_ASSIGNMENTS];
    return storesReady && this.zoneTree !== null && !this.hasPendingOwnershipGeneration();
  }

  /** Setup-internal activation gate for the per-home runtime registry. */
  isRuntimeActive(): boolean {
    return this.runtimeActive;
  }

  /**
   * Producer-resolved Main-home actuation fence. With active sub-homes,
   * zone-rule membership is provisional until a real zone tree has committed.
   * Independently, an explicit Main meter may never also own a sub-home: the
   * same sample would then drive two controllers over disjoint device sets.
   * Both reasons close the same final write seam (plan + terminal smart task).
   */
  isMainHomeActuationFenced(): boolean {
    if (this.hasPendingOwnershipGeneration()) return true;
    if (!this.isOwnershipReady()) return true;
    // ONE resolution: power source, configured meter, and the sampled meter are
    // all answered inside the authority owner, so nothing here re-reads a
    // side-effecting settings value the line above already resolved.
    if (this.meterAuthority.resolveForActuation(this.authorityContext()) !== 'ready') return true;
    return this.runtimeActive && this.subHomes.length > 0 && this.zoneTree === null;
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
      // Diagnostics describe SAVED configuration even while the control port is
      // held all-main for legacy compatibility.
      hasSubHomes: this.subHomes.length > 0,
      runtimeActive: this.runtimeActive,
      mainMeterArrangement: this.mainMeterArrangement,
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
    if (homesRead.state === 'present') {
      this.subHomes = homesRead.value.subHomes;
      this.runtimeActive = isHomeConfigRuntimeActive(
        homesRead.value,
        this.deps.legacyMultiHomeEnabled,
      );
    }
    if (homesRead.state === 'unwritten') {
      this.subHomes = [];
      this.runtimeActive = true;
    }
    if (homesRead.state !== 'suspect') {
      this.hasSeenNonSuspectReadByStoreKey[HOMES_CONFIG] = true;
    }
    this.noteSuspectEdge(HOMES_CONFIG, homesRead.state === 'suspect');
    const pinsRead = this.deps.assignmentsStore.read();
    if (pinsRead.state === 'present') this.pins = pinsRead.value;
    if (pinsRead.state === 'unwritten') this.pins = {};
    if (pinsRead.state !== 'suspect') {
      this.hasSeenNonSuspectReadByStoreKey[DEVICE_HOME_ASSIGNMENTS] = true;
    }
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
    const diagnosticFingerprint = `${this.runtimeActive ? 'active' : 'held'}|${fingerprint}`;
    if (diagnosticFingerprint === this.lastRecomputeFingerprint) return;
    this.lastRecomputeFingerprint = diagnosticFingerprint;
    this.deps.getLogger()?.info({
      event: 'home_membership_recomputed',
      runtimeActive: this.runtimeActive,
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
    const fingerprint = (this.runtimeActive ? Object.entries(this.membershipByDeviceId) : [])
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
   * Re-probe Main authority after an ownership input changes. Explicit-meter
   * reads use bounded scheduling; a completed semantic homes/pins recompute
   * may request immediate application. Both rebuild and reconcile while fenced.
   */
  requestMainAuthorityRecovery?: (timing?: 'scheduled' | 'immediate') => void;
  /**
   * Detach every recompute trigger wired by `createHomeMembershipService`
   * (refresh subscription + zone-tree-commit and realtime zone-move
   * callbacks): late dispatches after teardown become no-ops. The
   * settings-change trigger is not wired here — it reads `ctx.homeMembership`
   * lazily and dies when the wiring clears it.
   */
  teardown: () => void;
};

/** The narrow control-path slice of {@link HomeMembershipPort} the home-device filter consumes. */
type HomeMembershipControlView = Pick<
  HomeMembershipPort,
  'hasSubHomes' | 'getHomeIdForDevice' | 'getConfiguredMeterSources'
>;

/**
 * Controllable-device filter for one home's device views — the SINGLE seam
 * shared by the plan input (`buildMainHomeScope.getPlanDevices`) and the
 * sample-pipeline snapshot view (`createHomePowerPipeline`). It first applies
 * the membership complement, then removes every configured meter device:
 * meters are power sources regardless of which home's zone/pin membership they
 * resolve to. Consumes ONLY the producer-resolved control surface — never the
 * diagnostics view or membership `source`.
 *
 * Identity guard: before the service is wired, or with no sub-homes and no
 * explicit Main meter, the MAIN home gets the SAME array reference. A resolved
 * Main meter is deliberately removed even in single-home operation because a
 * power source is never a controllable load.
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
  if (!membership) return homeId === MAIN_HOME_ID ? devices : [];
  let homeDevices: T[];
  if (membership.hasSubHomes()) {
    homeDevices = devices.filter(
      (device) => membership.getHomeIdForDevice(device.id) === homeId,
    );
  } else {
    homeDevices = homeId === MAIN_HOME_ID ? devices : [];
  }
  const meterSources = membership.getConfiguredMeterSources();
  if (meterSources.state === 'unavailable') return [];
  const { deviceIds: meterDeviceIds } = meterSources;
  return meterDeviceIds.size === 0
    ? homeDevices
    : homeDevices.filter((device) => !meterDeviceIds.has(device.id));
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
  /** See {@link HomeMembershipServiceDeps.getRestoredSampleAtMs}. */
  getRestoredSampleAtMs?: () => number | undefined;
  /** See {@link HomeMembershipServiceDeps.onMembershipChanged}. */
  onMembershipChanged?: () => void;
  /** See {@link HomeMembershipServiceDeps.onRuntimeActiveChanged}. */
  onRuntimeActiveChanged?: (runtimeActive: boolean) => void;
  /** See {@link HomeMembershipServiceDeps.onMainOwnershipReady}. */
  onMainOwnershipReady?: () => void;
  /** See {@link HomeMembershipServiceDeps.onMainAuthorityUnresolved}. */
  onMainAuthorityUnresolved?: () => void;
  /** See {@link HomeMembershipServiceDeps.onMainAuthorityReopened}. */
  onMainAuthorityReopened?: () => void;
  /** See {@link HomeMembershipServiceDeps.onOwnershipReadyBeforePlanWork}. */
  onOwnershipReadyBeforePlanWork?: (
    membership: HomeMembershipService,
    allowPendingOwnershipGeneration: boolean,
  ) => void;
  /** See {@link HomeMembershipServiceDeps.onZoneTreeCommitReady}. */
  onZoneTreeCommitReady?: () => void;
}): HomeMembershipWiring => {
  const service = new HomeMembershipService({
    homesStore: createHomesStore(params.homey),
    assignmentsStore: createDeviceHomeAssignmentsStore(params.homey),
    getZoneTree: params.getZoneTree,
    getDevices: params.getDevices,
    getLogger: params.getLogger,
    getConfiguredPowerSource: () => readConfiguredPowerSource(params.homey.settings),
    getMainMeterSelection: () => readMainMeterSelection(params.homey.settings),
    getRestoredSampleAtMs: params.getRestoredSampleAtMs,
    legacyMultiHomeEnabled: readLegacyMultiHomeEnabled(params.homey.settings),
    onMembershipChanged: params.onMembershipChanged,
    onRuntimeActiveChanged: params.onRuntimeActiveChanged,
    onMainOwnershipReady: params.onMainOwnershipReady,
    onMainAuthorityUnresolved: params.onMainAuthorityUnresolved,
    onMainAuthorityReopened: params.onMainAuthorityReopened,
    onOwnershipReadyBeforePlanWork: params.onOwnershipReadyBeforePlanWork,
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
