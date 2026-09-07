/**
 * One home's power-tracker state and its persistence — the Main home and every
 * meter area alike. The durable copy lives in the userdata store
 * (`trackerStore.ts`), one row per bucket, and a persist writes only the rows
 * that changed since the last one.
 *
 * `homey.settings` is read exactly once, at boot, and only when the store
 * holds nothing for the home: that is the legacy blob installs wrote before
 * the store existed, and it is imported and then unset. The classification
 * that read used to need — a suspect SDK read latches persistence closed
 * until a valid tracker is adopted, so one transient miss can never let the
 * next persist overwrite the history it failed to read — is kept for that
 * one migrating boot, because it is the last moment the blob can be lost.
 * A store read does not have that failure mode: it either answers or throws.
 *
 * Boot hydration has two shapes. A meter area is hydrated by the runtime
 * registry before construction (`preparePersistedHomeTrackerForMeter`, which
 * refuses to build the bundle on a suspect legacy read). The Main home cannot
 * refuse to boot, so it hydrates itself through `hydrate` at its boot step:
 * a stored tracker is adopted, an unwritten one leaves the in-memory state
 * standing, and a suspect legacy one starts the run fenced with the reprobe
 * ladder armed.
 *
 * An unwritten read is never a reset: whatever the process holds stands and
 * the next persist writes it. Nothing in the runtime clears a home's rows;
 * only the owner's reset does.
 */
import type { StructuredDebugEmitter, Logger as PinoLogger } from '../logging/logger';
import type { TimerRegistry } from '../utils/timerRegistry';
import type {
  PowerTrackerMeterIdentity,
  PowerTrackerState,
} from './trackerTypes';
import {
  prunePowerTrackerHistoryForApp,
  type PowerTrackerPersistReason,
} from './sampleIngest';
import { getHourBucketKey } from '../utils/dateUtils';
import { normalizeError } from '../utils/errorUtils';
import { addPerfDuration, incPerfCounter } from '../utils/perfCounters';
import {
  POWER_TRACKER_STATE,
  homeScopedSettingsKey,
  type HomeId,
} from '../utils/settingsKeys';
import { VOLATILE_WRITE_THROTTLE_MS } from '../utils/timingConstants';
import {
  powerTrackerMeterIdentityMatches,
  readPersistedHomeTracker,
  unsetLegacyHomeTracker,
  type TrackerSettingsPort,
} from './persistedHomeTracker';
import type { TrackerStore } from './trackerStore';

const TRACKER_PRUNE_INITIAL_DELAY_MS = 10 * 1000;
const TRACKER_PRUNE_INTERVAL_MS = 60 * 60 * 1000;
const TRACKER_REPROBE_INITIAL_DELAY_MS = 1_000;
const TRACKER_REPROBE_MAX_DELAY_MS = 60_000;
const TRACKER_REPROBE_MAX_EXPONENT = 6;

/** Whether `candidate` carries a whole-home sample stamped later than `baseline`'s. */
const isNewerSample = (candidate: PowerTrackerState, baseline: PowerTrackerState): boolean => {
  const candidateTs = candidate.lastTimestamp;
  if (typeof candidateTs !== 'number' || !Number.isFinite(candidateTs)) return false;
  const baselineTs = baseline.lastTimestamp;
  return typeof baselineTs !== 'number' || !Number.isFinite(baselineTs) || candidateTs > baselineTs;
};

const crossesHourBoundary = (
  previous: PowerTrackerState,
  next: PowerTrackerState,
): boolean => {
  const previousTs = previous.lastTimestamp;
  const nextTs = next.lastTimestamp;
  if (
    typeof previousTs !== 'number' || typeof nextTs !== 'number'
    || !Number.isFinite(previousTs) || !Number.isFinite(nextTs)
  ) return false;
  return getHourBucketKey(previousTs) !== getHourBucketKey(nextTs);
};

/**
 * Which meter a tracker's samples belong to. A meter area's tracker is BOUND
 * to its configured meter: the identity is stamped on every persisted state,
 * and a persisted tracker carrying another identity is refused (the registry
 * rebuilds the bundle on a meter change). The Main home's tracker is UNBOUND:
 * its meter is governed at runtime by the Main-meter authority and the
 * sampled-meter identity, its persisted state carries no identity, and a
 * source or meter switch never fences its persistence.
 */
export type TrackerMeterBinding =
  | { kind: 'bound'; identity: PowerTrackerMeterIdentity }
  | { kind: 'unbound' };

export type HomeTrackerPersistence = {
  getState: () => PowerTrackerState;
  /**
   * Take `next` as the current state without starting a persist: a pending
   * debounced persist, the prune, and the next save all read the state at
   * the moment they write. The daily-budget cap recorder rewrites the tracker
   * this way after every sample it has just been saved for.
   */
  adopt: (next: PowerTrackerState) => void;
  /** Pipeline save path: `adopt` + `commit` against the state before it. */
  save: (next: PowerTrackerState) => void;
  /**
   * Decide the persist for the transition from `previous` to the current
   * state: a crossed hour boundary persists at once, anything else joins the
   * debounce. Lets a caller adopt a sample, let the cap recorder rewrite the
   * tracker, and still commit the whole transition in one write.
   */
  commit: (previous: PowerTrackerState) => void;
  /**
   * Owner-driven replacement (the settings UI's reset): adopt + persist now.
   * An explicit discard is the one owner action that outranks the fence — a
   * blob this run could not read is exactly what the owner is throwing away
   * — so it lifts the fence, drops the home's rows and writes `next` whole.
   * `false` only when the write itself fails, which the caller must surface,
   * never swallow.
   */
  replace: (next: PowerTrackerState) => boolean;
  /**
   * Boot hydration of a home that cannot refuse to boot: adopt the stored
   * tracker, or import the legacy settings blob once, or start fenced on a
   * suspect legacy read.
   */
  hydrate: () => void;
  /** Meter swap: drop freshness so the next new-meter sample re-primes it. */
  resetFreshness: () => boolean;
  /** Aggregate and prune history, then persist. */
  prune: () => void;
  startPruning: () => void;
  /** Flush a pending debounced persist, then stop the tracker timers. */
  stopAndFlush: () => void;
};

/**
 * The collaborators this controller needs, flat.
 *
 * It used to take the whole `AppContext`, which is why it could only live in
 * the wiring layer: `no-domain-to-app-layer` forbids a domain module from
 * naming that type. The bag was never the concept — each field below is a
 * separate seam, and the controller reaches for seven of them.
 */
export type HomeTrackerPersistenceDeps = {
  /** Opened on first use, so a controller built at construction does not open the file. */
  getStore: () => TrackerStore;
  /** Read once at boot for the legacy blob, then unset. Never written. */
  legacySettings: TrackerSettingsPort;
  timers: TimerRegistry;
  /** Structured logger; absent before structured logging is wired. */
  getLogger: () => PinoLogger | undefined;
  getPruneDebugEmitter: () => StructuredDebugEmitter;
  reportError: (message: string, error: Error) => void;
  getTimeZone: () => string;
  /** Teardown fence: a late pipeline continuation must not re-arm persistence. */
  isTornDown: () => boolean;
  /**
   * Persistence reopened on a reprobe after a fenced read, with a valid
   * tracker now in hand. Whatever bootstrapped off the fenced (blank or
   * stale) state — the daily budget's snapshot, a Flow feed's planning
   * cadence — is told to refresh from the recovered one.
   */
  onRecovered: () => void;
  /**
   * A persist landed in the store. The settings UI used to learn this from
   * the `settings.set` echo of the tracker key; the store is silent, so the
   * wiring turns this into the realtime push the UI refreshes on.
   */
  onPersisted: () => void;
};

type HomeTrackerPersistenceParams = {
  deps: HomeTrackerPersistenceDeps;
  homeId: HomeId;
  initialState: PowerTrackerState;
  /**
   * What the store already holds for the home when the controller is built —
   * the diff base of its first save. A meter area is hydrated before
   * construction and passes the state it loaded; the Main home passes `null`
   * and learns the base in `hydrate`.
   */
  persistedState: PowerTrackerState | null;
  meterBinding: TrackerMeterBinding;
  timerKey: (suffix: string) => string;
};

class HomeTrackerPersistenceController implements HomeTrackerPersistence {
  private state: PowerTrackerState;
  /** What the store holds for this home — the diff base of the next save. */
  private lastPersisted: PowerTrackerState | null;
  private persistenceFenced = false;
  private persistenceReprobeAttempt = 0;
  private readonly legacyKey: string;

  constructor(private readonly params: HomeTrackerPersistenceParams) {
    this.state = this.stamp(params.initialState);
    this.lastPersisted = params.persistedState;
    this.legacyKey = homeScopedSettingsKey(POWER_TRACKER_STATE, params.homeId);
  }

  getState = (): PowerTrackerState => this.state;

  adopt = (next: PowerTrackerState): void => {
    this.state = this.stamp(next);
  };

  save = (next: PowerTrackerState): void => {
    if (this.params.deps.isTornDown()) return;
    const previous = this.state;
    this.adopt(next);
    this.commit(previous);
  };

  commit = (previous: PowerTrackerState): void => {
    if (this.params.deps.isTornDown()) return;
    if (this.persistenceFenced) return;
    if (crossesHourBoundary(previous, this.state)) {
      incPerfCounter('power_tracker_store.forced_hour_rollover_total');
      this.persist('hour_rollover');
      return;
    }
    if (!this.params.deps.timers.has(this.params.timerKey('powerTrackerSave'))) {
      incPerfCounter('power_tracker_store.scheduled_total');
      this.params.deps.timers.registerTimeout(
        this.params.timerKey('powerTrackerSave'),
        setTimeout(() => this.persist('scheduled'), VOLATILE_WRITE_THROTTLE_MS),
      );
      return;
    }
    incPerfCounter('power_tracker_store.skipped_pending_total');
  };

  replace = (next: PowerTrackerState): boolean => {
    if (this.params.deps.isTornDown()) return false;
    const wasFenced = this.persistenceFenced;
    this.persistenceFenced = false;
    this.clearPersistenceReprobe();
    this.params.deps.timers.clear(this.params.timerKey('powerTrackerSave'));
    this.state = this.stamp(next);
    // The owner is discarding whatever was there, on disk and in the legacy
    // key alike: the rows are cleared and the replacement written whole, in
    // one transaction, so a failure leaves the old rows and the old diff base.
    const persisted = this.writeStore('ui_replace', true);
    if (persisted) unsetLegacyHomeTracker(this.params.deps.legacySettings, this.legacyKey);
    if (persisted && wasFenced) {
      this.params.deps.getLogger()?.info({
        event: 'home_power_tracker_reload_recovered',
        homeId: this.params.homeId,
        detail: 'tracker persistence reopened by the owner\'s reset',
      });
    }
    return persisted;
  };

  hydrate = (): void => {
    this.reload();
  };

  resetFreshness = (): boolean => {
    if (this.persistenceFenced && !this.reload()) return false;
    this.state = { ...this.state, lastTimestamp: undefined, lastPowerW: undefined };
    return this.persist('write');
  };

  prune = (): void => {
    const { deps } = this.params;
    this.state = prunePowerTrackerHistoryForApp({
      powerTracker: this.state,
      debugStructured: deps.getPruneDebugEmitter(),
      error: (message, error) => deps.reportError(message, error),
      timeZone: deps.getTimeZone(),
    });
    this.persist('prune');
  };

  startPruning = (): void => {
    const { deps, timerKey } = this.params;
    deps.timers.registerTimeout(timerKey('trackerPruneInitial'), setTimeout(() => {
      deps.timers.clear(timerKey('trackerPruneInitial'));
      this.prune();
    }, TRACKER_PRUNE_INITIAL_DELAY_MS));
    deps.timers.registerInterval(
      timerKey('trackerPruneInterval'),
      setInterval(() => this.prune(), TRACKER_PRUNE_INTERVAL_MS),
    );
  };

  stopAndFlush = (): void => {
    const { deps, timerKey } = this.params;
    if (deps.timers.has(timerKey('powerTrackerSave'))) this.persist('uninit');
    for (const suffix of [
      'powerTrackerSave',
      'trackerPersistenceReprobe',
      'trackerPruneInitial',
      'trackerPruneInterval',
    ]) {
      deps.timers.clear(timerKey(suffix));
    }
  };

  /** The state as this home persists it: a bound tracker carries its meter identity. */
  private stamp(state: PowerTrackerState): PowerTrackerState {
    const { meterBinding } = this.params;
    return meterBinding.kind === 'bound' ? { ...state, meterIdentity: meterBinding.identity } : state;
  }

  private matchesBinding(value: PowerTrackerState): boolean {
    const { meterBinding } = this.params;
    return meterBinding.kind === 'unbound'
      || powerTrackerMeterIdentityMatches(value.meterIdentity, meterBinding.identity);
  }

  private persist(reason: PowerTrackerPersistReason): boolean {
    this.params.deps.timers.clear(this.params.timerKey('powerTrackerSave'));
    if (this.persistenceFenced) return false;
    return this.writeStore(reason, false);
  }

  /**
   * Write the current state to the store: the changed rows against
   * `lastPersisted`, or — `whole` — every row after clearing the home's.
   */
  private writeStore(reason: PowerTrackerPersistReason | 'migration', whole: boolean): boolean {
    const { deps, homeId } = this.params;
    try {
      const writeStart = Date.now();
      const store = deps.getStore();
      if (whole) store.replace(homeId, this.state);
      else store.save(homeId, this.state, this.lastPersisted);
      addPerfDuration('power_tracker_store_write_ms', Date.now() - writeStart);
      this.lastPersisted = this.state;
      incPerfCounter('power_tracker_store.save_total');
      incPerfCounter(`power_tracker_store.save_reason.${reason}_total`);
      deps.onPersisted();
      return true;
    } catch (error) {
      deps.getLogger()?.error({
        event: 'home_power_tracker_persist_failed',
        homeId,
        reason,
        err: normalizeError(error),
      });
      return false;
    }
  }

  private fencePersistence(error?: Error): void {
    const { deps, homeId, timerKey } = this.params;
    deps.timers.clear(timerKey('powerTrackerSave'));
    if (!this.persistenceFenced) {
      deps.getLogger()?.error({
        event: 'home_power_tracker_reload_suspect',
        homeId,
        ...(error === undefined ? {} : { err: normalizeError(error) }),
        detail: 'fencing tracker persistence until a valid legacy tracker is reloaded',
      });
    }
    this.persistenceFenced = true;
    this.schedulePersistenceReprobe();
  }

  private schedulePersistenceReprobe(): void {
    const { deps, timerKey } = this.params;
    if (
      this.params.deps.isTornDown()
      || deps.timers.has(timerKey('trackerPersistenceReprobe'))
    ) return;
    const delayMs = Math.min(
      TRACKER_REPROBE_INITIAL_DELAY_MS * (2 ** this.persistenceReprobeAttempt),
      TRACKER_REPROBE_MAX_DELAY_MS,
    );
    if (this.persistenceReprobeAttempt === TRACKER_REPROBE_MAX_EXPONENT - 1) {
      // The ladder is at its cap: the same bytes are being refused on every
      // read. A transient miss has long passed; this is a blob the guard
      // rejects, and the fence will hold until a valid write or the owner's
      // reset. Say so once, at warn, so it is triagable in the logs.
      deps.getLogger()?.warn({
        event: 'home_power_tracker_persistence_fenced_persistently',
        homeId: this.params.homeId,
        detail: 'persistence stays fenced; history accrues in memory only until a valid tracker is read '
          + 'or the owner resets it',
      });
    }
    this.persistenceReprobeAttempt = Math.min(
      this.persistenceReprobeAttempt + 1,
      TRACKER_REPROBE_MAX_EXPONENT,
    );
    deps.timers.registerTimeout(
      timerKey('trackerPersistenceReprobe'),
      setTimeout(() => {
        deps.timers.clear(timerKey('trackerPersistenceReprobe'));
        if (this.params.deps.isTornDown()) return;
        this.reload();
      }, delayMs),
    );
  }

  private clearPersistenceReprobe(): void {
    this.params.deps.timers.clear(this.params.timerKey('trackerPersistenceReprobe'));
    this.persistenceReprobeAttempt = 0;
  }

  /**
   * Adopt what is durable. The store answers first; the legacy settings blob
   * is consulted only while the store holds nothing, and is imported the
   * moment it reads valid.
   */
  private reload(): boolean {
    const { deps, homeId } = this.params;
    let stored: PowerTrackerState | null;
    try {
      stored = deps.getStore().load(homeId);
    } catch (error) {
      this.fencePersistence(new Error(`failed to read the tracker store for ${homeId}`, { cause: error }));
      return false;
    }
    if (stored !== null) {
      if (!this.matchesBinding(stored)) {
        this.fencePersistence();
        return false;
      }
      // A legacy blob still present beside stored rows is one an earlier
      // import could not unset; it holds nothing the store does not.
      unsetLegacyHomeTracker(deps.legacySettings, this.legacyKey);
      return this.adoptDurable(stored, stored);
    }
    const read = readPersistedHomeTracker(deps.legacySettings, this.legacyKey);
    if (read.state === 'suspect') {
      this.fencePersistence();
      return false;
    }
    if (read.state === 'unwritten') {
      // Once fenced, absence may itself be an SDK omission; it is not repair.
      if (this.persistenceFenced) {
        this.schedulePersistenceReprobe();
        return false;
      }
      // Nothing durable to adopt: the in-memory state stands (a transient
      // absence is a no-op, never a reset), and the next persist writes it.
      this.lastPersisted = null;
      return true;
    }
    if (!this.matchesBinding(read.value)) {
      this.fencePersistence();
      return false;
    }
    const adopted = this.adoptDurable(read.value, null);
    if (adopted) this.migrateLegacy();
    return adopted;
  }

  /**
   * `value` is durable and valid; `persisted` is what the store already holds
   * (`null` for a legacy blob). A boot fence that recovers to a blob OLDER than
   * what this run has already admitted must not rewind it: the newest sample
   * wins, and it is persisted over the stale one. Restoring a stale stamp over
   * a live reading would, on a Flow feed with no further sample, look like a
   * silent meter to the escalation clock.
   */
  private adoptDurable(value: PowerTrackerState, persisted: PowerTrackerState | null): boolean {
    const recovered = this.persistenceFenced;
    this.persistenceFenced = false;
    this.clearPersistenceReprobe();
    this.lastPersisted = persisted;
    if (recovered && isNewerSample(this.state, value)) {
      this.save(this.state);
    } else {
      this.state = this.stamp(value);
    }
    if (recovered) {
      this.params.deps.getLogger()?.info({
        event: 'home_power_tracker_reload_recovered',
        homeId: this.params.homeId,
        detail: 'tracker persistence reopened after a valid legacy tracker read',
      });
      this.params.deps.onRecovered();
    }
    return true;
  }

  /** Write the just-adopted legacy blob to the store, then retire the key. */
  private migrateLegacy(): void {
    if (!this.writeStore('migration', false)) return;
    unsetLegacyHomeTracker(this.params.deps.legacySettings, this.legacyKey);
    this.params.deps.getLogger()?.info({
      event: 'home_power_tracker_migrated_to_store',
      homeId: this.params.homeId,
      legacyKey: this.legacyKey,
    });
  }
}

export const createHomeTrackerPersistence = (
  params: HomeTrackerPersistenceParams,
): HomeTrackerPersistence => new HomeTrackerPersistenceController(params);
