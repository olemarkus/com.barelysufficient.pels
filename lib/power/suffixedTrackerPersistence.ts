/**
 * Per-home power-tracker state and suffixed persistence.
 *
 * Initial hydration is resolved by the registry before construction. Live
 * reloads remain classified: a suspect read latches every write path closed
 * until a valid present tracker with the same meter identity is adopted.
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

export type SuffixedTrackerPersistence = {
  getState: () => PowerTrackerState;
  /** Pipeline save path: adopt + debounce-persist (hour rollovers force). */
  save: (next: PowerTrackerState) => void;
  /** Suffix-hook reload with own-write echo suppression. */
  reloadFromSettings: () => void;
  /** Meter swap: drop freshness so the next new-meter sample re-primes it. */
  resetFreshness: () => boolean;
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
type SuffixedTrackerPersistenceDeps = {
  settings: TrackerSettingsPort;
  timers: TimerRegistry;
  /** `homes` structured logger; absent before structured logging is wired. */
  getLogger: () => PinoLogger | undefined;
  getPruneDebugEmitter: () => StructuredDebugEmitter;
  reportError: (message: string, error: Error) => void;
  getTimeZone: () => string;
};

type SuffixedTrackerPersistenceParams = {
  deps: SuffixedTrackerPersistenceDeps;
  homeId: HomeId;
  initialState: PowerTrackerState;
  meterIdentity: PowerTrackerMeterIdentity;
  timerKey: (suffix: string) => string;
  /** Teardown fence: a late pipeline continuation must not re-arm persistence. */
  isTornDown: () => boolean;
};

class SuffixedTrackerPersistenceController implements SuffixedTrackerPersistence {
  private state: PowerTrackerState;
  private lastPersistedJson: string | null = null;
  private persistenceFenced = false;
  private persistenceReprobeAttempt = 0;
  private readonly trackerKey: string;

  constructor(private readonly params: SuffixedTrackerPersistenceParams) {
    this.state = { ...params.initialState, meterIdentity: params.meterIdentity };
    this.trackerKey = homeScopedSettingsKey(POWER_TRACKER_STATE, params.homeId);
  }

  getState = (): PowerTrackerState => this.state;

  save = (next: PowerTrackerState): void => {
    if (this.params.isTornDown()) return;
    const previous = this.state;
    this.state = { ...next, meterIdentity: this.params.meterIdentity };
    if (this.persistenceFenced) return;
    if (crossesHourBoundary(previous, next)) {
      this.persist('hour_rollover');
      return;
    }
    if (!this.params.deps.timers.has(this.params.timerKey('powerTrackerSave'))) {
      this.params.deps.timers.registerTimeout(
        this.params.timerKey('powerTrackerSave'),
        setTimeout(() => this.persist('scheduled'), VOLATILE_WRITE_THROTTLE_MS),
      );
    }
  };

  reloadFromSettings = (): void => {
    this.reload();
  };

  resetFreshness = (): boolean => {
    if (this.persistenceFenced && !this.reload()) return false;
    this.state = { ...this.state, lastTimestamp: undefined, lastPowerW: undefined };
    return this.persist('write');
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

  private persist(reason: PowerTrackerPersistReason): boolean {
    const { deps, homeId, timerKey } = this.params;
    deps.timers.clear(timerKey('powerTrackerSave'));
    if (this.persistenceFenced) return false;
    try {
      const serialized = JSON.stringify(this.state);
      deps.settings.set(this.trackerKey, this.state);
      this.lastPersistedJson = serialized;
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

  private prune(): void {
    const { deps } = this.params;
    this.state = prunePowerTrackerHistoryForApp({
      powerTracker: this.state,
      debugStructured: deps.getPruneDebugEmitter(),
      error: (message, error) => deps.reportError(message, error),
      timeZone: deps.getTimeZone(),
    });
    this.persist('prune');
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
      this.params.isTornDown()
      || deps.timers.has(timerKey('trackerPersistenceReprobe'))
    ) return;
    const delayMs = Math.min(
      TRACKER_REPROBE_INITIAL_DELAY_MS * (2 ** this.persistenceReprobeAttempt),
      TRACKER_REPROBE_MAX_DELAY_MS,
    );
    this.persistenceReprobeAttempt = Math.min(
      this.persistenceReprobeAttempt + 1,
      TRACKER_REPROBE_MAX_EXPONENT,
    );
    deps.timers.registerTimeout(
      timerKey('trackerPersistenceReprobe'),
      setTimeout(() => {
        deps.timers.clear(timerKey('trackerPersistenceReprobe'));
        if (this.params.isTornDown()) return;
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
      this.state = { meterIdentity: this.params.meterIdentity };
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
    if (!powerTrackerMeterIdentityMatches(value.meterIdentity, this.params.meterIdentity)) {
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
      return true;
    }
    this.state = value;
    this.lastPersistedJson = serialized;
    this.persistenceFenced = false;
    this.clearPersistenceReprobe();
    if (recovered) this.logPersistenceRecovered();
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

export const createSuffixedTrackerPersistence = (
  params: SuffixedTrackerPersistenceParams,
): SuffixedTrackerPersistence => new SuffixedTrackerPersistenceController(params);
