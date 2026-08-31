/**
 * Main-home meter authority: the single owner of "may Main act on the power
 * reading it is getting?".
 *
 * Three questions used to be answered in three places — the active power source,
 * the configured Main-meter selection, and (newly) the identity of the meter the
 * poll actually SAMPLED. Keeping them together matters because they share state:
 * the same edge-trigger latches, the same `findMainMeterCollision` predicate, and
 * the same two settings reads. Split across files, the sampled check had to
 * re-read the power source and the selection that its caller had just resolved,
 * and `readMainMeterSelection` is side-effecting (latches + an authority-
 * unresolved callback), so it fired twice per gate evaluation.
 *
 * The sampled identity exists for the switchover window: the moment the
 * user picks a non-colliding Main meter the configured id is proven clean, but
 * the tracker and capacity guard still serve the watts of whatever meter the
 * LAST admitted sample came from — the replacement poll is started without
 * being awaited (`handleHomeyEnergyMeterChange`). Authority reopens only when
 * an admitted sample replaces those watts with safe provenance, or when an
 * admitted Flow sample replaces them after a source switch.
 *
 * A RESTART inside that same window is the third case, and the reason the
 * sampled clause has a fail-closed state at all: `loadPowerTracker` restores
 * the durable `lastPowerW`/`lastTimestamp`, so the tracker resumes serving —
 * and the planner resumes treating as fresh — watts that were sampled before
 * this process existed, while nothing restores the identity that governed them.
 * An empty identity owner must therefore not read as "nothing was sampled": it
 * is exactly the state in which those watts could be a meter area's.
 *
 * Two entry points, deliberately:
 * - `resolveForCommit` — power source + configured selection only. This gates the
 *   ownership-generation commit, and through it smart-task scope resolution and
 *   the starvation rescue list. An unattributable power READING is a reason not
 *   to command a device, not a reason to stall membership bookkeeping.
 * - `resolveForActuation` — the same, plus the sampled-identity clause. Only the
 *   final write seam consults this.
 */
import {
  findMainMeterCollision,
  type SubHomeConfig,
} from '../lib/home/homeConfig';
import type { Logger as PinoLogger } from '../lib/logging/logger';
import type { MainMeterSelection } from '../packages/contracts/src/mainMeterSelection';
import { SampledMeterIdentity, type SampledMeterIdentityDeps } from './homeSampledMeterIdentity';
import type { ConfiguredPowerSourceRead } from './powerSourceSettings';

export type MainMeterAuthorityState = 'ready' | 'retry' | 'blocked';

export type MainMeterAuthorityDeps = {
  getLogger: () => PinoLogger | undefined;
  getMainMeterSelection: () => MainMeterSelection;
  /**
   * The active power source, classified at the settings boundary. Required:
   * this is one of the two authorities the fence is made of, and the only
   * default an absent dep could carry is `homey_energy` — the historical
   * source, asserted as fact for a home nobody asked. `suspect` fences; an
   * unwired dep must not be able to look like an answer.
   */
  getConfiguredPowerSource: () => ConfiguredPowerSourceRead;
  /** See {@link SampledMeterIdentityDeps.getRestoredSampleAtMs}. */
  getRestoredSampleAtMs?: () => number | undefined;
  onMainAuthorityUnresolved?: () => void;
  /**
   * Fired on the sampled clause's blocked -> ready edge. While the fence was
   * closed, Main kept BUILDING and COMMITTING plans; only the final actuator
   * was nulled (`createFencedActuator` returns `requested:false`). A shed
   * planned in that window is therefore already part of the committed plan, so
   * the ordinary next rebuild sees an unchanged action signature and
   * `maybeApplyPlanChanges` skips it — `hasStablePlanActuation` covers restore/
   * release/step actuation only, never a shed. Main would then stay unshed over
   * its hard cap until some unrelated device happened to change the signature.
   * The wiring turns this edge into the same rebuild-then-reconcile recovery
   * the ownership-readiness edge uses (the drift is "device still on while the
   * plan sheds"), mirroring `reloadCapacityScalars`'s dry-run activation path.
   *
   * Also fired when the first Flow sample is admitted after a source switch.
   * That sample replaces the retained Homey-Energy watts; the setting alone
   * cannot safely settle the episode.
   */
  onSampledAuthorityReopened?: () => void;
};

/** The membership state each resolution is evaluated against. */
export type MainMeterAuthorityContext = {
  runtimeActive: boolean;
  subHomes: readonly SubHomeConfig[];
};

export type ConfiguredMeterSources =
  | { state: 'resolved'; deviceIds: ReadonlySet<string> }
  | { state: 'unavailable'; deviceIds: ReadonlySet<string> };

/**
 * Why the sampled clause is holding Main's write seam closed. Two reasons, both
 * "the watts the tracker serves may be a meter area's": one PROVEN (this
 * process sampled the area's own meter), one UNPROVABLE (a restart handed us
 * watts whose meter died with the previous process).
 */
type SampledFence =
  | { reason: 'meter_area_collision'; meterDeviceId: string; homeId: string }
  | { reason: 'unattributable_restored_sample' };

type SampledFenceReason = SampledFence['reason'];

export class MainMeterAuthority {
  /**
   * `undefined` means no authoritative Main-meter selection has been observed.
   * A transient unavailable read retains the last-good identity but closes
   * every control consumer.
   */
  private lastResolvedMainMeterDeviceId: string | undefined;

  private mainMeterUnavailableLogged = false;

  private powerSourceUnavailableLogged = false;

  private mainMeterCollisionLogged = false;

  /**
   * Which sampled-clause reason last warned. Reason-valued rather than boolean
   * so a fence that CHANGES reason (a restart fence whose first admitted sample
   * turns out to be the area's own meter) still logs the new one exactly once.
   */
  private loggedSampledFenceReason: SampledFenceReason | null = null;

  /**
   * Which meter the watts the tracker currently serves came from, plus the
   * retention rule for reads that cannot re-prove it and the restart window in
   * which no read can. Owned separately because nothing else in this module's
   * state is involved in it.
   */
  private readonly sampledIdentity: SampledMeterIdentity;

  /**
   * Last AUTHORITATIVE active power source. `undefined` until one resolves, and
   * never overwritten by a suspect read — the same last-good discipline
   * `lastResolvedMainMeterDeviceId` uses, so the pure predicate below can mirror
   * `resolve()`'s power-source gate without re-running a side-effecting read.
   */
  private lastResolvedPowerSource: 'homey_energy' | 'flow' | undefined;

  constructor(private readonly deps: MainMeterAuthorityDeps) {
    // Assigned here, not as a field initializer: `deps` is a constructor
    // parameter property and is not initialized when field initializers run.
    const identityDeps: SampledMeterIdentityDeps = deps.getRestoredSampleAtMs === undefined
      ? {}
      : { getRestoredSampleAtMs: deps.getRestoredSampleAtMs };
    this.sampledIdentity = new SampledMeterIdentity(identityDeps);
  }

  /**
   * True while a sampled-clause fence episode has closed Main's write seam and
   * its committed-but-unactuated plan has not yet been handed to recovery. A
   * LATCH, not a time check, deliberately: the raw provenance can expire when
   * the colliding sample ages out during a read blackout, but a shed already
   * committed behind this write fence still exists. The next admitted
   * Homey-Energy ingest that finds the provenance safe settles the episode.
   * After a switch to Flow, the first admitted Flow sample settles it because
   * the setting alone does not replace the retained watts.
   */
  private sampledFenceEpisode = false;

  /**
   * Admitted-ingest push seam (`noteResolvedHomeMeter`): the power-sample
   * pipeline calls this atomically with each ingested whole-home sample,
   * stamped with the ingest's own `sampleAtMs`. It is never called from a raw
   * read, so the fence can only move together with the watts it governs: a
   * reopening is observed only AFTER the non-colliding sample is already the
   * one the tracker serves, and the identity's expiry shares the sample's
   * clock. Cheap and idempotent.
   *
   * Retention/expiry lives in `SampledMeterIdentity`; this method owns only the
   * consequence — settling a fence episode into the rebuild+reconcile recovery.
   */
  noteResolvedHomeMeter(
    deviceId: string,
    sampleAtMs: number,
    ctx: MainMeterAuthorityContext,
  ): void {
    this.sampledIdentity.note(deviceId, sampleAtMs);
    if (this.hasSampledFence(ctx)) {
      this.sampledFenceEpisode = true;
      return;
    }
    // The episode is over — repaired by this sample's identity, or already
    // expired with its sample.
    this.settleSampledFenceEpisode();
  }

  /**
   * Admit the first Flow-card sample after a source switch. Flow samples do not
   * carry meter identity, but they do replace the tracker's retained Homey
   * Energy watts. A pending sampled-meter fence may therefore settle only at
   * this boundary — the settings read alone is too early.
   */
  noteAdmittedFlowHomeSample(): void {
    this.lastResolvedPowerSource = 'flow';
    this.sampledIdentity.noteFlowReplacement();
    this.settleSampledFenceEpisode();
  }

  /**
   * Settle a pending fence episode into the rebuild+reconcile recovery: clear
   * the latch, re-arm the edge-triggered warn so a later re-collision logs
   * again, then hand the reopening to the recovery owner. A no-op when no
   * episode is pending, so both settle sites share the exactly-once contract.
   */
  private settleSampledFenceEpisode(): void {
    if (!this.sampledFenceEpisode) return;
    this.sampledFenceEpisode = false;
    this.loggedSampledFenceReason = null;
    this.deps.onSampledAuthorityReopened?.();
  }

  /**
   * Does the CURRENTLY STORED sampled provenance fence Main? Pure — no settings
   * read — because this rides the per-read push seam, and both settings readers
   * below are side-effecting (they log, latch, and fire
   * `onMainAuthorityUnresolved`).
   *
   * It mirrors the gates `resolve()` applies before reaching `resolveSampled`,
   * using only cached last-good reads:
   * - Flow carries no meter identity, so neither collision check applies. A
   *   flow sample never carries an identity field, so this seam is not reached
   *   in flow mode at all — the cached-source guard stays as defence in depth:
   *   without it, a leftover selection from an earlier `homey_energy` session
   *   would latch a phantom fence from any caller that ever reached this seam.
   * - `=== undefined` is load-bearing. `lastResolvedMainMeterDeviceId` is the
   *   last AUTHORITATIVE configured selection: `null` is a proven Automatic, a
   *   string a proven explicit id, `undefined` never read at all. Before any
   *   authoritative read the sampled clause has never been the operative fence
   *   (`resolve()` returns before `readMainMeterSelection()` on flow or an
   *   unavailable source, and `isMainHomeActuationFenced` returns before
   *   `resolveForActuation` while ownership is unready or a generation is
   *   pending), so latching here would request recovery for a fence that never
   *   closed. A PROVEN selection — Automatic OR explicit — keeps the clause
   *   live: right after a switch away from a colliding pick the stored sample
   *   still carries the area's watts, and the seam must not reopen on the new
   *   selection alone (watts-before-fence, see `resolve()`).
   * - The configured-collision gate is deliberately NOT mirrored: while an
   *   explicit selection itself collides, `resolve()` returns 'blocked' before
   *   the sampled clause, so the write seam is closed anyway and an episode
   *   latched here records a real reconcile debt.
   */
  private hasSampledFence(ctx: MainMeterAuthorityContext): boolean {
    if (!ctx.runtimeActive || ctx.subHomes.length === 0) return false;
    if (this.lastResolvedPowerSource !== 'homey_energy') return false;
    if (this.lastResolvedMainMeterDeviceId === undefined) return false;
    return this.sampledFence(ctx) !== null;
  }

  /**
   * The sampled clause's fence lookup, shared so the two callers can't drift.
   * `resolveFor(Date.now())` makes provenance expiry a property of the CHECK:
   * the raw sampled reason disappears when the watts stop being fresh. A
   * previously latched actuation episode remains closed until replacement
   * ingest hands it to fresh-plan recovery. This holds for the restart window
   * too: a sample already expired at boot never starts an episode.
   */
  private sampledFence(ctx: MainMeterAuthorityContext): SampledFence | null {
    const provenance = this.sampledIdentity.resolveFor(Date.now());
    if (provenance.state === 'unknown') return null;
    if (provenance.state === 'unattributable') {
      return { reason: 'unattributable_restored_sample' };
    }
    const collision = findMainMeterCollision(provenance.deviceId, ctx.subHomes);
    return collision === null ? null : {
      reason: 'meter_area_collision',
      meterDeviceId: provenance.deviceId,
      homeId: collision.homeId,
    };
  }

  /** Authority for membership bookkeeping: configured inputs only. */
  resolveForCommit(ctx: MainMeterAuthorityContext): MainMeterAuthorityState {
    return this.resolve(ctx, false);
  }

  /** Authority for the final write seam: configured inputs plus what was sampled. */
  resolveForActuation(ctx: MainMeterAuthorityContext): MainMeterAuthorityState {
    return this.resolve(ctx, true);
  }

  private resolve(
    ctx: MainMeterAuthorityContext,
    includeSampled: boolean,
  ): MainMeterAuthorityState {
    const powerSource = this.readActiveMeterPowerSource();
    if (powerSource === 'unavailable') return 'retry';
    // A Flow sample carries no meter identity, so neither collision check can
    // apply, and the persisted selections are dormant — reading one would let a
    // stale or malformed setting fence otherwise valid managed loads.
    if (powerSource === 'flow') {
      // A source switch does not replace the watts already in the tracker.
      // Resolve provenance here as well as in Homey-Energy mode so a fresh
      // restored sample can start the episode even when no earlier actuation
      // check observed it. Keep that episode fenced until the first admitted
      // Flow sample settles it and the wiring takes over with a fresh-plan
      // ownership generation.
      if (!includeSampled || !ctx.runtimeActive || ctx.subHomes.length === 0) return 'ready';
      return this.resolveSampled(ctx);
    }
    const selection = this.readMainMeterSelection();
    if (selection.state === 'unavailable') return 'retry';
    if (!ctx.runtimeActive || ctx.subHomes.length === 0) {
      this.mainMeterCollisionLogged = false;
      this.loggedSampledFenceReason = null;
      return 'ready';
    }
    const configured = findMainMeterCollision(selection.meterDeviceId, ctx.subHomes);
    if (configured !== null && !this.mainMeterCollisionLogged) {
      this.deps.getLogger()?.warn({
        event: 'main_home_meter_ownership_conflict',
        meterDeviceId: selection.meterDeviceId,
        subHomeId: configured.homeId,
        detail: 'fencing Main actuation because one explicit meter has two owners',
      });
    }
    this.mainMeterCollisionLogged = configured !== null;
    if (configured !== null) return 'blocked';
    if (!includeSampled) return 'ready';
    // The sampled clause guards the WATTS the tracker currently serves, not
    // the selection, so it runs for explicit selections too. An explicit id
    // was just proven collision-free, but right after a switch away from a
    // colliding legacy/transient selection (Automatic that sampled an area's
    // meter, or an explicit area meter) the last ADMITTED sample is still the
    // area's — the
    // replacement poll is started without being awaited
    // (`handleHomeyEnergyMeterChange`), and a slow or failed poll would
    // otherwise reconcile the fenced plan against the old area's watts. The
    // seam reopens only when a sample admitted under the new selection proves
    // the tracker serves safe watts. Provenance expiry alone cannot actuate a
    // shed already committed behind the fence.
    return this.resolveSampled(ctx);
  }

  /**
   * The sampled-provenance clause. An UNKNOWN identity does NOT block,
   * deliberately: the hazard is Main sampling exactly an area's meter, which
   * requires an id match, and an area meter always reports under its own id —
   * so an admitted sample with a missing id cannot be that case. A reading that
   * merely INCLUDES an area is the separate, documented, conservative case
   * (Main sheds its own devices). Blocking on unknown would also close this
   * seam for the whole boot window, and it is shared with smart-task authority,
   * so it would report tasks unavailable on every start of a legitimately
   * configured home. A real collision is caught within one poll of the sample
   * arriving.
   *
   * UNATTRIBUTABLE is the opposite answer, because it is a different fact: the
   * tracker is serving watts RESTORED across a restart, and no ingest of this
   * process ever attested them. The "a missing id cannot be the hazard"
   * reasoning above holds only for a sample this process admitted; here the id
   * is missing because it died with the previous process, so those watts may be
   * exactly an area meter's. That window is narrow and self-limiting — it ends
   * at the first admitted ingest (one Homey Energy poll), and in any case when
   * the restored sample stops being able to reach a decision — so fail closed
   * rather than authorize Main against watts nobody can vouch for.
   */
  private resolveSampled(ctx: MainMeterAuthorityContext): MainMeterAuthorityState {
    const fence = this.sampledFence(ctx);
    this.logSampledFenceEdge(fence);
    // The episode latch is also an actuation fence. Sample expiry stops new
    // plans from trusting the watts, but it does not remove an already
    // committed shed intent; only a later admitted sample may hand the episode
    // to fresh-plan recovery.
    if (fence !== null) this.sampledFenceEpisode = true;
    return fence === null && !this.sampledFenceEpisode ? 'ready' : 'blocked';
  }

  /**
   * Edge-triggered sampled-clause warn, latched by REASON: a persistent fence
   * logs once, and a fence that switches reason logs the new one once more.
   */
  private logSampledFenceEdge(fence: SampledFence | null): void {
    if (fence === null) {
      this.loggedSampledFenceReason = null;
      return;
    }
    if (fence.reason !== this.loggedSampledFenceReason) {
      this.deps.getLogger()?.warn(fence.reason === 'meter_area_collision'
        ? {
          event: 'main_home_sampled_meter_ownership_conflict',
          meterDeviceId: fence.meterDeviceId,
          subHomeId: fence.homeId,
          detail: 'fencing Main actuation: the sampled whole-home meter is owned by a meter area',
        }
        : {
          event: 'main_home_restored_sample_provenance_unproven',
          detail: 'fencing Main actuation: the reloaded power sample predates this session,'
            + ' so the meter behind it is unproven',
        });
    }
    this.loggedSampledFenceReason = fence.reason;
  }

  /**
   * Meter identity is source ownership, independent of device membership. A meter
   * outside its area's zone may resolve to Main, but it remains a source device
   * and must never enter any home's controllable set.
   */
  getConfiguredMeterSources(ctx: MainMeterAuthorityContext): ConfiguredMeterSources {
    const powerSource = this.readActiveMeterPowerSource();
    if (powerSource === 'unavailable') {
      return { state: 'unavailable', deviceIds: this.knownConfiguredMeterDeviceIds(ctx) };
    }
    if (powerSource === 'flow') return { state: 'resolved', deviceIds: new Set() };
    const mainSelection = this.readMainMeterSelection();
    return { state: mainSelection.state, deviceIds: this.knownConfiguredMeterDeviceIds(ctx) };
  }

  private knownConfiguredMeterDeviceIds(ctx: MainMeterAuthorityContext): ReadonlySet<string> {
    const main = this.lastResolvedMainMeterDeviceId;
    return new Set([
      ...(main === undefined ? [] : [main]),
      ...(ctx.runtimeActive
        ? ctx.subHomes.flatMap((home) => (home.meterDeviceId === null ? [] : [home.meterDeviceId]))
        : []),
    ]);
  }

  private readActiveMeterPowerSource(): 'homey_energy' | 'flow' | 'unavailable' {
    const read: ConfiguredPowerSourceRead = this.deps.getConfiguredPowerSource();
    if (read.state === 'suspect') {
      if (!this.powerSourceUnavailableLogged) {
        this.deps.getLogger()?.warn({
          event: 'meter_source_power_source_unavailable',
          detail: 'fencing control until the active power source is authoritative',
        });
      }
      this.powerSourceUnavailableLogged = true;
      this.mainMeterCollisionLogged = false;
      this.deps.onMainAuthorityUnresolved?.();
      return 'unavailable';
    }
    this.powerSourceUnavailableLogged = false;
    this.lastResolvedPowerSource = read.value;
    if (read.value === 'flow') {
      this.mainMeterUnavailableLogged = false;
      this.mainMeterCollisionLogged = false;
    }
    return read.value;
  }

  private readMainMeterSelection(): MainMeterSelection {
    const selection = this.deps.getMainMeterSelection();
    if (selection.state === 'unavailable') {
      if (!this.mainMeterUnavailableLogged) {
        this.deps.getLogger()?.warn({
          event: 'main_home_meter_authority_unavailable',
          detail: 'fencing control until the Main meter selection is authoritative',
        });
      }
      this.mainMeterUnavailableLogged = true;
      this.mainMeterCollisionLogged = false;
      this.deps.onMainAuthorityUnresolved?.();
      return selection;
    }
    this.mainMeterUnavailableLogged = false;
    this.lastResolvedMainMeterDeviceId = selection.meterDeviceId;
    return selection;
  }
}
