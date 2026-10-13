/**
 * Registry of per-home capacity bundles (multi-home R7b): one
 * {@link SubHomeBundle} per configured sub-home, reconciled against the
 * persisted homes registry (`homes_config`) at boot and on every
 * homes-config change. With ZERO sub-homes configured the registry is empty
 * and no bundle code runs — the main home's path is untouched.
 *
 * Reconcile semantics follow the store's discriminated read
 * (`HomeStoreReadResult`): `'present'` reconciles to the normalized list,
 * `'unwritten'` to empty, and `'suspect'` KEEPS the current bundles — the
 * persisted truth is unknown, and tearing down running control loops on one
 * flaky read would be exactly the destructive reset the persisted-settings
 * rules forbid. Root-zone/name changes update in place; a changed meter
 * identity replaces the bundle behind teardown's in-flight fences.
 *
 * Suffix-hook consumer (`onHomeScopedSettingChanged` contract in
 * `lib/utils/settingsHandlers.ts`): calls are idempotent dirty-marks — an
 * unknown homeId triggers ONE reconcile against the registry and is otherwise
 * ignored as transient (never a teardown, never an error). The tracker no
 * longer rides a settings key at all (it persists to the userdata store), so
 * no tracker echo reaches this hook.
 *
 * Sample routing: `routeMeterReadings` receives the per-meter map one
 * `manager/energy/live` poll resolved (transport seam
 * `onAdditionalMeterReadings`) and feeds each home's OWN meter reading to
 * that home's pipeline. A home with no meter, or whose meter produced no
 * finite reading this poll, gets NO sample — freshness machinery handles the
 * gap; a zero is never fabricated.
 *
 * The registry owns its state and every transition over it: the bundle map,
 * the recovery retry backoff, the stop latch, the activation bookkeeping and
 * the prepared ownership samples. Home imports no other domain, so what it
 * cannot name arrives as ports: each area's bundle is composed by the wiring
 * (`setup/homeRuntime/homeRuntimeRegistry.ts`) from the plan, power and price
 * factories, and the power owner's source-epoch fence
 * (`lib/power/powerSourceEpochFence.ts`) is handed in as {@link MeterSourceEpoch}.
 */
import type { Logger as PinoLogger } from '../logging/logger';
import type { ConfiguredPowerSourceRead, PowerSource } from '../ports/configuredPowerSource';
import type { TimerRegistry } from '../utils/timerRegistry';
import {
  CAPACITY_PRIORITIES,
  MAIN_HOME_ID,
  MODE_ALIASES,
  MODE_CATALOG_INITIALIZED,
  MODE_DEVICE_TARGETS,
  OPERATING_MODE_SETTING,
  type HomeId,
} from '../utils/settingsKeys';
import type { HomesStore, SubHomeConfig } from './homeConfig';
import type { HomeMembershipService } from './homeMembershipService';
import type {
  HomeRuntimeDiagnostics,
  HomeRuntimeReading,
  HomeRuntimeReadPort,
  HomeRuntimeReadResult,
} from './homeRuntimeRead';
import {
  logBundleReplacementFailure,
  logHomeReadFailed,
  logHomeScopedSettingForUnknownHome,
  logIncompleteIdentityTransition,
  logPowerSourceTransitionIncomplete,
  logSubHomesUnderFlowSource,
} from './homeRuntimeRegistryLogs';
import type { ModeOwnershipTransfer } from './modeOwnershipTransfer';
import type { SubHomeSampleRevision } from './subHomeRecovery';

const MODE_CATALOG_BASE_KEYS: ReadonlySet<string> = new Set([
  OPERATING_MODE_SETTING,
  MODE_ALIASES,
  CAPACITY_PRIORITIES,
  MODE_DEVICE_TARGETS,
  MODE_CATALOG_INITIALIZED,
]);

const RECOVERY_RETRY_TIMER_KEY = 'homeRuntimeRegistryRecovery';
const RECOVERY_RETRY_INITIAL_DELAY_MS = 1_000;
const RECOVERY_RETRY_MAX_DELAY_MS = 60_000;
const RECOVERY_RETRY_MAX_EXPONENT = 6;

/**
 * One sub-home's self-contained, capacity-only control loop, as the registry
 * and the wiring's consumers hold it. Built by the wiring
 * (`setup/homeRuntime/createHomeCapacityBundle.ts`); `THooks` is its
 * owning-home routing surface, which names plan seams lib/home does not.
 */
export type SubHomeBundle<THooks> = {
  homeId: HomeId;
  /** True after teardown has closed every writer/actuator seam. */
  isTornDown: () => boolean;
  /** Current reconciled config, used when a source transition replaces the runtime. */
  getHomeConfig: () => SubHomeConfig;
  /** This home's meter device id (fresh from the last reconciled config). */
  getMeterDeviceId: () => string | null;
  getDiagnostics: () => HomeRuntimeDiagnostics;
  /**
   * This home's already-committed state for the per-home UI read seam
   * (`lib/home/homeRuntimeRead.ts`): the last committed plan snapshot, this
   * home's tracker state, and the diagnostics above. Pure reads — no rebuild,
   * no snapshot refresh/decorate, no actuation.
   */
  getReadModel: () => HomeRuntimeReading;
  /**
   * Owning-home routing hooks: the observed-control-state wiring binds these
   * for a device this home owns, so the hold, the suppressions and any rebuild
   * are answered by THIS bundle rather than main's.
   */
  getOwningHomeHooks: () => THooks;
  /** Adopt a same-meter config change (root-zone/name) without teardown. */
  updateHomeConfig: (home: SubHomeConfig) => void;
  /** Rebuild the plan after this area's mode catalog changes. */
  rebuildForModeSettingsChange: () => void;
  /** Rebuild after a global per-device command-authority policy change. */
  rebuildForDeviceControlSettingsChange: () => void;
  /** Re-read this area's coherent suffixed mode catalog. */
  reloadModeCatalog: (allowPendingOwnershipGeneration?: boolean) => void;
  isModeCatalogInitialized: () => boolean;
  /**
   * Apply the membership-ready edge (`lib/home/subHomeMembershipReadyEdge.ts`).
   * Idempotent and latched; a no-op until the execution gate opens. Driven by
   * the registry from the membership tree-commit transition (decoupled from
   * sample arrival).
   */
  applyMembershipReadyEdge: () => void;
  /**
   * The area's side of the ownership-generation protocol
   * (`lib/home/subHomeOwnershipGeneration.ts`): rebuild after an ownership
   * change, commit a fresh plan behind the generation fence (its token is the
   * sample revision), say whether it is still current, and apply it.
   */
  rebuildForMembershipChange: () => Promise<boolean>;
  prepareOwnershipGeneration: () => Promise<SubHomeSampleRevision>;
  isPreparedOwnershipGenerationCurrent: (sampleRevision: number) => boolean;
  reconcilePreparedOwnershipGeneration: (sampleRevision: number) => Promise<boolean>;
  /** Feed one meter reading (W) into this home's sample pipeline. */
  recordMeterSample: (powerW: number, nowMs: number) => void;
  /**
   * A home-scoped key other than a mode-catalog key was written: the capacity
   * owner notes the write and reloads when it names one of its scalars.
   */
  onScopedSettingWritten: (baseKey: string) => void;
  /**
   * Stop timers/scheduler. Identity changes additionally clear and durably
   * persist meter freshness after the final pending-state flush.
   *
   * Returns false only when the requested durable freshness reset failed. The
   * runtime is already fenced in that case; callers must retain it as a
   * tombstone and retry the reset before constructing a replacement.
   */
  teardown: (options?: { resetMeterFreshness?: boolean }) => boolean;
};

/** The wiring's side of an area's construction, which needs factories lib/home may not import. */
export type SubHomeBundleFactory<THooks> = {
  /**
   * Build one area's bundle against `powerSource`, its tracker already
   * resolved against that meter identity. Throws when the tracker cannot be
   * prepared; the registry keeps the old runtime fenced and retries.
   */
  create(home: SubHomeConfig, powerSource: PowerSource): SubHomeBundle<THooks>;
  /** Clear a dormant area's persisted meter freshness before its activation; false = retry. */
  resetDormantTrackerFreshness(homeId: HomeId): boolean;
};

/** What the registry reads from membership; `HomeMembershipService` satisfies it. */
type SubHomeRegistryMembership = Pick<HomeMembershipService, 'isRuntimeActive' | 'getHomeIdForDevice'>;

/**
 * The power owner's source-epoch fence (`lib/power/powerSourceEpochFence.ts`),
 * as the registry drives it: which observed generation of the configured power
 * source has been durably handled, and whether sub-home meter samples may be
 * consumed right now.
 */
type MeterSourceEpoch = {
  /** The source every currently-committed bundle was constructed against. */
  readonly handledPowerSource: PowerSource;
  /** Latest observed generation; the value a transition attempt commits against. */
  readonly observedGeneration: number;
  readConfiguredSource(): ConfiguredPowerSourceRead;
  observeChange(): void;
  isTransitionPending(): boolean;
  markIncomplete(): void;
  reconcileObservedFromSettings(): 'unchanged' | 'observed' | 'unreadable';
  isMeterSourceAuthorized(): boolean;
  isHandledCurrent(generation: number): boolean;
  /** `null` = the read failed, which latches the fence closed. */
  resolveAuthoritativeSource(): PowerSource | null;
  isTransitionCurrent(powerSource: PowerSource, generation: number): boolean;
  commitTransition(powerSource: PowerSource, generation: number): void;
};

export class HomeRuntimeRegistry<THooks> implements HomeRuntimeReadPort {
  private readonly bundles = new Map<HomeId, SubHomeBundle<THooks>>();
  private recoveryRetryAttempt = 0;
  private stopped = false;
  private handledRuntimeActive: boolean;
  private readonly activationResetHomeIds = new Set<HomeId>();
  private readonly preparedOwnershipSamples = new Map<HomeId, {
    bundle: SubHomeBundle<THooks>;
    sampleRevision: number;
  }>();
  // Edge-latch for the flow-source misconfiguration warn (see the emitter).
  private subHomesUnderFlowWarned = false;

  constructor(
    private readonly homesStore: HomesStore,
    private readonly modeOwnershipTransfer: ModeOwnershipTransfer,
    private readonly membership: SubHomeRegistryMembership,
    private readonly bundleFactory: SubHomeBundleFactory<THooks>,
    // Source epochs are observed synchronously at the settings-event boundary,
    // before the serialized async handler runs. Authorization stays closed until
    // the latest observed generation has durably reset and replaced every bundle
    // (`powerSourceEpochFence.ts`).
    private readonly sourceEpoch: MeterSourceEpoch,
    private readonly timers: TimerRegistry,
    private readonly getLogger: () => PinoLogger | undefined,
  ) {
    this.handledRuntimeActive = membership.isRuntimeActive();
  }

  getLiveBundles(): SubHomeBundle<THooks>[] {
    return [...this.bundles.values()].filter((bundle) => !bundle.isTornDown());
  }

  private reconcileModeOwnershipTransfer(complete: boolean, deferred: boolean): boolean {
    if (deferred) return complete;
    return this.modeOwnershipTransfer.reconcile() && complete;
  }

  /** Live sub-home ids, for tests and diagnostics. */
  getBundleHomeIds(): HomeId[] {
    return this.getLiveBundles().map((bundle) => bundle.homeId);
  }

  /** Read-only per-bundle diagnostics (test observability + future `ui_homes`). */
  getDiagnostics(): HomeRuntimeDiagnostics[] {
    return this.getLiveBundles().map((bundle) => bundle.getDiagnostics());
  }

  /**
   * Already-committed state for ONE sub-home, backing the `AppContext` read
   * port (`lib/home/homeRuntimeRead.ts`). A pure read: it never reconciles,
   * rebuilds, or touches the device snapshot, so a UI poll costs nothing.
   *
   * `unavailable` is this producer's COMPLETE classification of every
   * non-serving case: no such sub-home (including the main home, which has no
   * bundle), a retained tombstone whose runtime is already fenced, and — via
   * the catch — anything the assembly throws. Completeness is the point: this
   * is the whole reason a consumer may treat the result as typed and never
   * reinterpret absence, so a raw exception must not escape and become an
   * unclassified failure at the endpoint. Every input is non-throwing by
   * inspection today; the boundary exists so that stays true as they change.
   */
  readHome(homeId: HomeId): HomeRuntimeReadResult {
    const bundle = this.bundles.get(homeId);
    if (!bundle || bundle.isTornDown()) return { state: 'unavailable' };
    try {
      return { state: 'resolved', reading: bundle.getReadModel() };
    } catch (error) {
      logHomeReadFailed(this.getLogger(), homeId, error);
      return { state: 'unavailable' };
    }
  }

  /**
   * Distinct configured meter ids across live bundles — the transport's
   * `getAdditionalMeterDeviceIds` provider (read fresh per poll).
   */
  getMeterDeviceIds(): string[] {
    const ids = new Set<string>();
    for (const bundle of this.bundles.values()) {
      if (bundle.isTornDown()) continue;
      const meterDeviceId = bundle.getMeterDeviceId();
      if (meterDeviceId !== null) ids.add(meterDeviceId);
    }
    return [...ids];
  }

  /**
   * Per-home routing (R7b P1#1): resolve a device to the OWNING sub-home
   * bundle's seams — its external-off-hold state and its plan rebuild. Both are
   * wrong if taken from main: main's plan filters sub-home members out, so it
   * does not contain the device, and its pending-command store never saw the
   * device's commands.
   *
   * Returns `undefined` for a main-home device, an unknown device, or a home
   * with no live bundle; the caller then goes through main's plan service
   * exactly as before (the no-sub-homes path stays byte-identical).
   */
  getOwningHomeRouteForDevice(deviceId: string): {
    homeId: HomeId;
    hooks: THooks;
  } | undefined {
    const homeId = this.membership.getHomeIdForDevice(deviceId);
    if (homeId === MAIN_HOME_ID) return undefined;
    const bundle = this.bundles.get(homeId);
    return bundle?.isTornDown() === false
      ? { homeId, hooks: bundle.getOwningHomeHooks() }
      : undefined;
  }

  /** Reconcile bundles against the persisted homes registry (see module doc). */
  reconcile(options: { deferModeOwnershipTransfer?: boolean } = {}): boolean {
    if (this.stopped) return false;
    // A failed source transition leaves every old runtime fenced in this map.
    // Retry that transition before reading/reconciling home config; otherwise a
    // normal reconcile could construct a bundle from the stale tracker value
    // whose durable reset failed.
    if (!this.completeObservedPowerSourceTransition()) {
      this.scheduleRecoveryRetry();
      return false;
    }

    const read = this.homesStore.read();
    // 'suspect' = persisted truth unknown → keep the current bundles running.
    if (read.state === 'suspect') {
      this.scheduleRecoveryRetry();
      return false;
    }
    const runtimeActive = this.membership.isRuntimeActive();
    const desired: readonly SubHomeConfig[] = read.state === 'present'
      && runtimeActive
      ? read.value.subHomes
      : [];
    if (!runtimeActive) this.activationResetHomeIds.clear();
    if (
      runtimeActive
      && !this.handledRuntimeActive
      && !this.resetDormantTrackerFreshness(desired)
    ) {
      this.scheduleRecoveryRetry();
      return false;
    }
    const desiredIds = new Set(desired.map((home) => home.homeId));
    let complete = this.removeUndesiredBundles(desiredIds);
    for (const home of desired) {
      complete = this.reconcileDesiredBundle(home) && complete;
    }
    this.warnIfSubHomesUnderFlowSource(desired.length);
    complete = this.reconcileModeOwnershipTransfer(
      complete,
      options.deferModeOwnershipTransfer === true,
    );
    if (complete) {
      this.handledRuntimeActive = runtimeActive;
      this.activationResetHomeIds.clear();
      this.clearRecoveryRetry();
    } else {
      this.scheduleRecoveryRetry();
    }
    return complete;
  }

  /**
   * Ownership-generation prepare phase: adopt the latest meter registry and
   * commit one fresh plan per live sub-home while membership actuation remains
   * fenced. False keeps the generation closed and lets the owner retry.
   */
  async prepareOwnershipGeneration(): Promise<boolean> {
    if (!this.reconcile()) return false;
    const bundles = this.getLiveBundles();
    const samples = await Promise.all(
      bundles.map((bundle) => bundle.prepareOwnershipGeneration()),
    );
    const prepared = !this.stopped && bundles.every((bundle, index) => {
      const sample = samples[index];
      return sample !== undefined
        && sample.state === 'stable'
        && this.bundles.get(bundle.homeId) === bundle
        && bundle.isPreparedOwnershipGenerationCurrent(sample.revision);
    });
    this.preparedOwnershipSamples.clear();
    if (!prepared) return false;
    for (const [index, bundle] of bundles.entries()) {
      const sample = samples[index];
      if (sample === undefined || sample.state !== 'stable') return false;
      this.preparedOwnershipSamples.set(bundle.homeId, {
        bundle,
        sampleRevision: sample.revision,
      });
    }
    return true;
  }

  isOwnershipGenerationPreparationCurrent(): boolean {
    return [...this.preparedOwnershipSamples.values()].every(({ bundle, sampleRevision }) => (
      this.bundles.get(bundle.homeId) === bundle
      && bundle.isPreparedOwnershipGenerationCurrent(sampleRevision)
    ));
  }

  /**
   * Apply the plans prepared behind the generation fence, then latch the
   * ordinary membership-ready edge so the next sample does not duplicate the
   * same rebuild/reconcile.
   */
  async reconcilePreparedOwnershipGeneration(): Promise<boolean> {
    const prepared = [...this.preparedOwnershipSamples.values()];
    this.preparedOwnershipSamples.clear();
    const reconciled = await Promise.all(prepared.map(({ bundle, sampleRevision }) => (
      bundle.reconcilePreparedOwnershipGeneration(sampleRevision)
    )));
    return reconciled.every(Boolean);
  }

  private removeUndesiredBundles(desiredIds: ReadonlySet<HomeId>): boolean {
    let complete = true;
    for (const [homeId, bundle] of [...this.bundles]) {
      if (desiredIds.has(homeId)) continue;
      // Removal is also a meter-identity boundary: a later config may reuse
      // this homeId with a different meter. Clear the old meter's durable
      // freshness before dropping the handle so that re-creation cannot
      // hydrate its timestamp. A failed write leaves the now-fenced bundle in
      // the map as a hidden tombstone; the next reconcile retries this call.
      if (!bundle.teardown({ resetMeterFreshness: true })) {
        complete = false;
        continue;
      }
      this.bundles.delete(homeId);
    }
    return complete;
  }

  private reconcileDesiredBundle(home: SubHomeConfig): boolean {
    const existing = this.bundles.get(home.homeId);
    if (existing) {
      const needsReplacement = existing.isTornDown()
        || existing.getMeterDeviceId() !== home.meterDeviceId;
      if (!needsReplacement) {
        existing.updateHomeConfig(home);
        return true;
      }
      if (!existing.teardown({ resetMeterFreshness: true })) {
        logIncompleteIdentityTransition(this.getLogger(), home);
        return false;
      }
    }
    try {
      const bundle = this.bundleFactory.create(home, this.sourceEpoch.handledPowerSource);
      this.bundles.set(home.homeId, bundle);
      bundle.reloadModeCatalog();
      return true;
    } catch (error) {
      logBundleReplacementFailure(this.getLogger(), home, error);
      return false;
    }
  }

  /**
   * Synchronous settings-event edge. This runs before the event is placed on
   * the serialized settings queue, so even a same-turn A→B→A round trip advances
   * the generation twice and closes authorization immediately.
   */
  observePowerSourceChange(): void {
    this.sourceEpoch.observeChange();
  }

  /**
   * Serialized settings-work edge. Production has already called
   * `observePowerSourceChange`; the raw-source fallback preserves direct callers
   * and one-way tests without weakening the synchronous ABA fence.
   */
  onPowerSourceChanged(): void {
    if (
      !this.sourceEpoch.isTransitionPending()
      && this.sourceEpoch.reconcileObservedFromSettings() === 'unchanged'
    ) return;
    if (!this.completeObservedPowerSourceTransition()) {
      this.scheduleRecoveryRetry();
      return;
    }
    this.reconcile();
  }

  /**
   * Sub-home bundles are driven ONLY by the per-meter fan-out of the
   * `manager/energy/live` poll, which never runs under `power_source = flow`
   * (`homeyEnergyPoll.ts`). So a sub-home configured in flow mode gets ZERO
   * meter samples for the app's lifetime: its bundle never opens its
   * measurement gate, so it never actuates. Surface a structured warning alongside the Multiple meters
   * UI's Homey Energy warning; edge-triggered so it logs once per transition
   * into the misconfigured state, not on every reconcile.
   */
  private warnIfSubHomesUnderFlowSource(subHomeCount: number): void {
    const configured = this.sourceEpoch.readConfiguredSource();
    if (configured.state !== 'resolved') return;
    const flowMode = configured.value !== 'homey_energy';
    const misconfigured = subHomeCount > 0 && flowMode;
    if (misconfigured && !this.subHomesUnderFlowWarned) {
      logSubHomesUnderFlowSource(this.getLogger(), subHomeCount);
    }
    this.subHomesUnderFlowWarned = misconfigured;
  }

  /**
   * Fire each bundle's once-only membership-ready apply-edge. Called by the
   * membership service on the zone-tree-commit transition (false→true), so the
   * committed dry-run plan is applied the moment execution becomes trustworthy —
   * decoupled from meter-sample arrival (works in flow mode too). Idempotent:
   * each bundle latches, so repeat calls are no-ops.
   */
  onMembershipReady(): void {
    for (const bundle of this.bundles.values()) {
      if (!bundle.isTornDown()) {
        bundle.reloadModeCatalog();
        bundle.applyMembershipReadyEdge();
      }
    }
  }

  /**
   * Make every area's persisted mode catalog available before owner-aware
   * support defaults are derived from an active mode. On first ownership
   * resolution this may create the dormant bundles; their normal membership
   * ready edge still controls plan application.
   */
  prepareModeCatalogsForOwnership(allowPendingOwnershipGeneration = false): boolean {
    // Catalog initialization must precede target transfer: a newly created
    // destination has no independent catalog for the transfer to write yet.
    if (!this.reconcile({ deferModeOwnershipTransfer: true })) return false;
    let ready = true;
    for (const bundle of this.getLiveBundles()) {
      bundle.reloadModeCatalog(allowPendingOwnershipGeneration);
      ready = bundle.isModeCatalogInitialized() && ready;
    }
    return ready && this.modeOwnershipTransfer.reconcile(allowPendingOwnershipGeneration);
  }

  /** Rebuild every live sub-home plan after the producer commits new ownership. */
  onMembershipChanged(): boolean {
    if (!this.reconcile()) return false;
    for (const bundle of this.getLiveBundles()) {
      bundle.reloadModeCatalog();
      void bundle.rebuildForMembershipChange();
    }
    return true;
  }

  /** Reload every live area's mode catalog: the home batteries became known, so held rank writes may run. */
  reloadModeCatalogs(): void {
    for (const bundle of this.getLiveBundles()) bundle.reloadModeCatalog();
  }

  /** Keep only pre-migration areas following a Main catalog change. */
  onModeSettingsChanged(): void {
    for (const bundle of this.getLiveBundles()) {
      if (bundle.isModeCatalogInitialized()) continue;
      bundle.reloadModeCatalog();
      bundle.rebuildForModeSettingsChange();
    }
  }

  /** Rebuild every live sub-home after a global per-device control policy change. */
  onDeviceControlSettingsChanged(): void {
    for (const bundle of this.getLiveBundles()) {
      bundle.rebuildForDeviceControlSettingsChange();
    }
  }

  /** Route one poll's per-meter readings to the owning bundles' pipelines. */
  routeMeterReadings(readings: Record<string, number>, nowMs: number): void {
    // Poll-discard parity (R7b): the transport fans these readings out from INSIDE
    // the live-report fetch, but only when the poll source AUTHORIZES it — its
    // generation + source liveness gate (`HomeyEnergyPollSource.pollNow`'s
    // `authorizeFanOut`). So a stale-generation poll (a whole-home-meter /
    // power-source restart superseded it) never reaches this routing at all, and an
    // out-of-order sub-meter sample cannot land. The power-source check is mirrored
    // here as belt-and-suspenders (and because tests drive `routeMeterReadings`
    // directly): if the source is not `homey_energy`, drop the readings.
    if (!this.sourceEpoch.isMeterSourceAuthorized()) return;
    for (const bundle of this.bundles.values()) {
      if (bundle.isTornDown()) continue;
      const meterDeviceId = bundle.getMeterDeviceId();
      if (meterDeviceId === null) continue;
      const reading = readings[meterDeviceId];
      if (reading === undefined) continue;
      bundle.recordMeterSample(reading, nowMs);
    }
  }

  /** Suffix-hook entry point (`SettingsHandlerDeps.onHomeScopedSettingChanged`). */
  onHomeScopedSettingChanged(baseKey: string, homeId: string): void {
    let bundle = this.bundles.get(homeId);
    if (!bundle) {
      // Unknown homeId = transient (the write may precede the homes_config
      // handler's reconcile): dirty-mark by reconciling once, then re-check.
      this.reconcile();
      bundle = this.bundles.get(homeId);
    }
    // A durable-reset own write is emitted synchronously while the fenced
    // tombstone is still retained. Its cleared state is already in memory;
    // ignore that echo without recursively reconciling or logging it as unknown.
    if (bundle?.isTornDown()) return;
    if (!bundle) {
      logHomeScopedSettingForUnknownHome(this.getLogger(), homeId, baseKey);
      return;
    }
    // Reload the owning area's coherent catalog before its plan rebuild.
    if (MODE_CATALOG_BASE_KEYS.has(baseKey)) {
      bundle.reloadModeCatalog();
      bundle.rebuildForModeSettingsChange();
      return;
    }
    bundle.onScopedSettingWritten(baseKey);
  }

  /** Uninit: tear down every bundle (persisted suffixed state stays). */
  teardownAll(): void {
    this.stopped = true;
    this.clearRecoveryRetry();
    this.preparedOwnershipSamples.clear();
    for (const bundle of this.bundles.values()) bundle.teardown();
    this.bundles.clear();
  }

  private resetDormantTrackerFreshness(homes: readonly SubHomeConfig[]): boolean {
    for (const home of homes) {
      if (this.activationResetHomeIds.has(home.homeId)) continue;
      if (!this.bundleFactory.resetDormantTrackerFreshness(home.homeId)) return false;
      this.activationResetHomeIds.add(home.homeId);
    }
    return true;
  }

  private completeObservedPowerSourceTransition(): boolean {
    const authoritativeSource = this.sourceEpoch.resolveAuthoritativeSource();
    if (authoritativeSource === null) return false;
    const generation = this.sourceEpoch.observedGeneration;
    if (this.sourceEpoch.isHandledCurrent(generation)) return true;

    const homes = [...this.bundles.values()].map((bundle) => bundle.getHomeConfig());
    if (!this.resetBundlesForPowerSourceTransition(generation, authoritativeSource)) return false;
    const replacements = this.createPowerSourceReplacementBundles(
      homes,
      generation,
      authoritativeSource,
    );
    if (replacements === null) return false;

    // Re-read the settings boundary immediately before commit. A transient
    // read failure or a source change while the transition was being prepared
    // leaves both generations fenced and hands recovery to the bounded retry;
    // no placeholder Flow assumption can become the handled authority.
    if (!this.sourceEpoch.isTransitionCurrent(authoritativeSource, generation)) {
      for (const bundle of replacements.values()) bundle.teardown();
      this.sourceEpoch.markIncomplete();
      return false;
    }

    // Commit LAST. All replacements were constructed while the incomplete latch
    // kept their dry-run and actuator seams closed.
    this.bundles.clear();
    for (const [homeId, bundle] of replacements) this.bundles.set(homeId, bundle);
    this.sourceEpoch.commitTransition(authoritativeSource, generation);
    this.warnIfSubHomesUnderFlowSource(homes.length);
    return true;
  }

  private resetBundlesForPowerSourceTransition(
    generation: number,
    powerSource: PowerSource,
  ): boolean {
    let resetsSucceeded = true;
    for (const bundle of this.bundles.values()) {
      if (!bundle.teardown({ resetMeterFreshness: true })) resetsSucceeded = false;
    }
    if (resetsSucceeded) return true;
    this.sourceEpoch.markIncomplete();
    logPowerSourceTransitionIncomplete(this.getLogger(), { generation, powerSource, cause: 'freshness_reset' });
    return false;
  }

  private createPowerSourceReplacementBundles(
    homes: readonly SubHomeConfig[],
    generation: number,
    powerSource: PowerSource,
  ): Map<HomeId, SubHomeBundle<THooks>> | null {
    const replacements = new Map<HomeId, SubHomeBundle<THooks>>();
    try {
      for (const home of homes) {
        replacements.set(home.homeId, this.bundleFactory.create(home, powerSource));
      }
      return replacements;
    } catch (error) {
      for (const bundle of replacements.values()) bundle.teardown();
      this.sourceEpoch.markIncomplete();
      logPowerSourceTransitionIncomplete(this.getLogger(), {
        generation,
        powerSource,
        cause: 'bundle_replacement',
        error,
      });
      return null;
    }
  }

  private scheduleRecoveryRetry(): void {
    if (this.stopped || this.timers.has(RECOVERY_RETRY_TIMER_KEY)) return;
    const exponent = Math.min(this.recoveryRetryAttempt, RECOVERY_RETRY_MAX_EXPONENT);
    const delayMs = Math.min(
      RECOVERY_RETRY_INITIAL_DELAY_MS * (2 ** exponent),
      RECOVERY_RETRY_MAX_DELAY_MS,
    );
    this.recoveryRetryAttempt = Math.min(
      this.recoveryRetryAttempt + 1,
      RECOVERY_RETRY_MAX_EXPONENT,
    );
    this.timers.registerTimeout(
      RECOVERY_RETRY_TIMER_KEY,
      setTimeout(() => {
        this.timers.clear(RECOVERY_RETRY_TIMER_KEY);
        if (!this.stopped) this.reconcile();
      }, delayMs),
    );
  }

  private clearRecoveryRetry(): void {
    this.timers.clear(RECOVERY_RETRY_TIMER_KEY);
    this.recoveryRetryAttempt = 0;
  }
}
