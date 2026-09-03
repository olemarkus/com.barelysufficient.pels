/**
 * One home's power-tracker state and its persistence — the Main home and every
 * meter area alike. Every write path is CLASSIFIED: a suspect read latches
 * persistence closed until a valid tracker is adopted again, so one transient
 * SDK miss can never let the next persist (the prune included) overwrite the
 * accounting history it failed to read.
 *
 * Boot hydration has two shapes. A meter area is hydrated by the runtime
 * registry before construction (`preparePersistedHomeTrackerForMeter`, which
 * refuses to build the bundle on a suspect read). The Main home cannot refuse
 * to boot, so it hydrates itself through `reloadFromSettings` at its boot
 * step: a present tracker is adopted, an unwritten one leaves the in-memory
 * state standing, and a suspect one starts the run fenced with the reprobe
 * ladder armed. An EMPTY key list classifies suspect (it cannot prove
 * absence), so the Main home relies on the boot migrations writing their
 * markers before its hydration step; a fresh install never hydrates on an
 * empty list.
 *
 * An unwritten read is never a reset: whatever the process holds stands and
 * the next persist rewrites the key. Nothing in the runtime unsets a tracker
 * key; only an owner deleting it by hand sees it resurrected.
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
  type TrackerSettingsPort,
} from './persistedHomeTracker';

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
 * sampled-meter identity, its persisted blob carries no identity, and a
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
   * — so it lifts the fence and persists. `false` only when the write itself
   * fails, which the caller must surface, never swallow.
   */
  replace: (next: PowerTrackerState) => boolean;
  /**
   * Classified reload from settings, with own-write echo suppression: the
   * boot hydration of a home that cannot refuse to boot, and the settings-hook
   * reload afterwards.
   */
  reloadFromSettings: () => void;
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
 * separate seam, and the controller reaches for six of them.
 */
export type HomeTrackerPersistenceDeps = {
  settings: TrackerSettingsPort;
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
};

type HomeTrackerPersistenceParams = {
  deps: HomeTrackerPersistenceDeps;
  homeId: HomeId;
  initialState: PowerTrackerState;
  meterBinding: TrackerMeterBinding;
  timerKey: (suffix: string) => string;
};

class HomeTrackerPersistenceController implements HomeTrackerPersistence {
  private state: PowerTrackerState;
  private lastPersistedJson: string | null = null;
  private persistenceFenced = false;
  private persistenceReprobeAttempt = 0;
  private readonly trackerKey: string;

  constructor(private readonly params: HomeTrackerPersistenceParams) {
    this.state = this.stamp(params.initialState);
    this.trackerKey = homeScopedSettingsKey(POWER_TRACKER_STATE, params.homeId);
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
      incPerfCounter('settings_set.power_tracker_state_forced_hour_rollover_total');
      this.persist('hour_rollover');
      return;
    }
    if (!this.params.deps.timers.has(this.params.timerKey('powerTrackerSave'))) {
      incPerfCounter('settings_set.power_tracker_state_scheduled_total');
      this.params.deps.timers.registerTimeout(
        this.params.timerKey('powerTrackerSave'),
        setTimeout(() => this.persist('scheduled'), VOLATILE_WRITE_THROTTLE_MS),
      );
      return;
    }
    incPerfCounter('settings_set.power_tracker_state_skipped_pending_total');
  };

  replace = (next: PowerTrackerState): boolean => {
    if (this.params.deps.isTornDown()) return false;
    const wasFenced = this.persistenceFenced;
    this.persistenceFenced = false;
    this.clearPersistenceReprobe();
    this.state = this.stamp(next);
    const persisted = this.persist('ui_replace');
    if (persisted && wasFenced) {
      this.params.deps.getLogger()?.info({
        event: 'home_power_tracker_reload_recovered',
        homeId: this.params.homeId,
        detail: 'tracker persistence reopened by the owner\'s reset',
      });
    }
    return persisted;
  };

  reloadFromSettings = (): void => {
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
    const { deps, homeId, timerKey } = this.params;
    deps.timers.clear(timerKey('powerTrackerSave'));
    if (this.persistenceFenced) return false;
    try {
      const serialized = JSON.stringify(this.state);
      const writeStart = Date.now();
      deps.settings.set(this.trackerKey, this.state);
      addPerfDuration('settings_write_ms', Date.now() - writeStart);
      this.lastPersistedJson = serialized;
      incPerfCounter('settings_set.power_tracker_state');
      incPerfCounter(`settings_set.power_tracker_state_reason.${reason}_total`);
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
        detail: 'fencing tracker persistence until a valid settings repair is reloaded',
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

  private reload(): boolean {
    const read = readPersistedHomeTracker(this.params.deps.settings, this.trackerKey);
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
      // absence is a no-op, never a reset), and the next persist rewrites it.
      this.lastPersistedJson = null;
      return true;
    }
    let serialized: string;
    try {
      serialized = JSON.stringify(read.value);
    } catch (error) {
      this.fencePersistence(new Error(`failed to serialize tracker state for ${this.trackerKey}`, {
        cause: error,
      }));
      return false;
    }
    if (!this.persistenceFenced && serialized === this.lastPersistedJson) return true;
    return this.adoptPresentTracker(read.value, serialized);
  }

  private adoptPresentTracker(value: PowerTrackerState, serialized: string): boolean {
    if (!this.matchesBinding(value)) {
      this.fencePersistence();
      return false;
    }
    const recovered = this.persistenceFenced;
    // A transient read/malformed episode must not rewind live accounting. If
    // settings recovers to the exact blob this controller last persisted, it
    // is positive evidence that no external repair superseded us. Reopen over
    // the newer in-memory state and schedule that accrued state for persistence.
    if (recovered && this.lastPersistedJson !== null && serialized === this.lastPersistedJson) {
      this.persistenceFenced = false;
      this.clearPersistenceReprobe();
      if (JSON.stringify(this.state) !== serialized) this.save(this.state);
      this.logPersistenceRecovered();
      this.params.deps.onRecovered();
      return true;
    }
    // A boot fence that recovers to a blob OLDER than what this run has
    // already admitted must not rewind it either: the newest sample wins, and
    // it is persisted over the stale blob. Restoring a stale stamp over a live
    // reading would, on a Flow feed with no further sample, look like a silent
    // meter to the escalation clock.
    if (recovered && this.lastPersistedJson === null && isNewerSample(this.state, value)) {
      this.persistenceFenced = false;
      this.clearPersistenceReprobe();
      this.save(this.state);
      this.logPersistenceRecovered();
      this.params.deps.onRecovered();
      return true;
    }
    this.state = value;
    this.lastPersistedJson = serialized;
    this.persistenceFenced = false;
    this.clearPersistenceReprobe();
    if (recovered) {
      this.logPersistenceRecovered();
      this.params.deps.onRecovered();
    }
    return true;
  }

  private logPersistenceRecovered(): void {
    this.params.deps.getLogger()?.info({
      event: 'home_power_tracker_reload_recovered',
      homeId: this.params.homeId,
      detail: 'tracker persistence reopened after a valid settings repair',
    });
  }
}

export const createHomeTrackerPersistence = (
  params: HomeTrackerPersistenceParams,
): HomeTrackerPersistence => new HomeTrackerPersistenceController(params);
