/**
 * One home's power-tracker state and its persistence — the Main home and every
 * meter area alike. The durable copy lives in the userdata store
 * (`trackerStore.ts`), one row per bucket; a persist hands the store the
 * whole state and the store writes the rows that changed since what it holds.
 *
 * The store either answers or throws. A failed persist is logged and the
 * next one is tried. The one read that must not be lost to a transient is
 * the boot hydration: a store that could not be read then is read again
 * before the first persist, and until that read succeeds nothing is written
 * — a blank tracker diffed against the rows on disk would delete the history
 * the failed read never adopted. What the process holds always stands — an
 * empty store at boot is never a reset, and the next persist writes it.
 *
 * Boot hydration has two shapes. A meter area is hydrated by the runtime
 * registry before construction (`trackerMeterIdentity.ts`, which prepares the
 * stored tracker for the area's meter). The Main home hydrates itself through
 * `hydrate` at its boot step: a stored tracker is adopted, an unwritten one
 * leaves the in-memory state standing.
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
import type { HomeId } from '../utils/settingsKeys';
import { VOLATILE_WRITE_THROTTLE_MS } from '../utils/timingConstants';
import type { TrackerStore } from './trackerStore';

const TRACKER_PRUNE_INITIAL_DELAY_MS = 10 * 1000;
const TRACKER_PRUNE_INTERVAL_MS = 60 * 60 * 1000;

/**
 * `current` with `stored`'s history under it: the run's scalars and entries
 * win, and every keyed family keeps the stored entries the run has not
 * touched.
 */
const withHistoryUnder = (current: PowerTrackerState, stored: PowerTrackerState): PowerTrackerState => {
  const merged: PowerTrackerState & Record<string, unknown> = { ...stored, ...current };
  for (const [key, storedValue] of Object.entries(stored)) {
    const currentValue: unknown = current[key as keyof PowerTrackerState];
    if (!isKeyedFamily(storedValue) || !isKeyedFamily(currentValue)) continue;
    merged[key] = key === 'deviceBuckets'
      ? mergeDeviceBuckets(storedValue as DeviceBuckets, currentValue as DeviceBuckets)
      : Object.assign({}, storedValue, currentValue);
  }
  return merged;
};

type DeviceBuckets = Record<string, Record<string, number>>;

const isKeyedFamily = (value: unknown): value is Record<string, unknown> => (
  typeof value === 'object' && value !== null && !Array.isArray(value)
);

const mergeDeviceBuckets = (stored: DeviceBuckets, current: DeviceBuckets): DeviceBuckets => {
  const merged: DeviceBuckets = { ...stored };
  for (const [deviceId, hours] of Object.entries(current)) {
    merged[deviceId] = Object.assign({}, stored[deviceId], hours);
  }
  return merged;
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
 * and the registry prepares a stored tracker for the area's meter before the
 * bundle is built. The Main home's tracker is UNBOUND: its meter is governed
 * at runtime by the Main-meter authority and the sampled-meter identity, and
 * its persisted state carries no identity.
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
   * Owner-driven replacement (the settings UI's reset): adopt + persist now,
   * dropping the home's rows and writing `next` whole. `false` only when the
   * write itself fails, which the caller must surface, never swallow.
   */
  replace: (next: PowerTrackerState) => boolean;
  /** Boot hydration of the Main home: adopt the stored tracker, if any. */
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
 * separate seam.
 */
export type HomeTrackerPersistenceDeps = {
  /** The tracker store, opened at the app's first boot step; a controller is built before that. */
  getStore: () => TrackerStore;
  timers: TimerRegistry;
  /** Structured logger; absent before structured logging is wired. */
  getLogger: () => PinoLogger | undefined;
  getPruneDebugEmitter: () => StructuredDebugEmitter;
  reportError: (message: string, error: Error) => void;
  getTimeZone: () => string;
  /** Teardown fence: a late pipeline continuation must not re-arm persistence. */
  isTornDown: () => boolean;
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
  meterBinding: TrackerMeterBinding;
  timerKey: (suffix: string) => string;
};

class HomeTrackerPersistenceController implements HomeTrackerPersistence {
  private state: PowerTrackerState;
  /** A boot read the store failed to answer; persistence stays closed until it does. */
  private hydrationOwed = false;

  constructor(private readonly params: HomeTrackerPersistenceParams) {
    this.state = this.stamp(params.initialState);
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
    this.params.deps.timers.clear(this.params.timerKey('powerTrackerSave'));
    this.state = this.stamp(next);
    // The owner is discarding whatever was there: the rows are cleared and
    // the replacement written whole, in one transaction, so a failure leaves
    // the old rows in place.
    return this.writeStore('ui_replace', true);
  };

  hydrate = (): void => {
    const { deps, homeId } = this.params;
    let stored: PowerTrackerState | null;
    try {
      stored = deps.getStore().load(homeId);
    } catch (error) {
      // The in-memory state stands; the read is owed again before the first
      // persist, and nothing is written until it succeeds.
      this.hydrationOwed = true;
      deps.getLogger()?.error({
        event: 'home_power_tracker_hydrate_failed',
        homeId,
        err: normalizeError(error),
      });
      return;
    }
    if (stored !== null) this.state = this.stamp(stored);
  };

  resetFreshness = (): boolean => {
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
    for (const suffix of ['powerTrackerSave', 'trackerPruneInitial', 'trackerPruneInterval']) {
      deps.timers.clear(timerKey(suffix));
    }
  };

  /** The state as this home persists it: a bound tracker carries its meter identity. */
  private stamp(state: PowerTrackerState): PowerTrackerState {
    const { meterBinding } = this.params;
    return meterBinding.kind === 'bound' ? { ...state, meterIdentity: meterBinding.identity } : state;
  }

  private persist(reason: PowerTrackerPersistReason): boolean {
    this.params.deps.timers.clear(this.params.timerKey('powerTrackerSave'));
    return this.writeStore(reason, false);
  }

  /**
   * The boot read, owed again: adopt the stored history under what this run
   * has accrued since, so the persist that follows carries both. A throw
   * keeps the read owed and the write unmade.
   */
  private settleOwedHydration(): boolean {
    const { deps, homeId } = this.params;
    if (!this.hydrationOwed) return true;
    const stored = deps.getStore().load(homeId);
    this.hydrationOwed = false;
    if (stored !== null) this.state = this.stamp(withHistoryUnder(this.state, stored));
    deps.getLogger()?.info({ event: 'home_power_tracker_hydrated_late', homeId, stored: stored !== null });
    return true;
  }

  /**
   * Write the current state to the store: the rows that changed since what
   * the store holds, or — `whole` — every row after clearing the home's. The
   * owner's `replace` discards the stored history by intent and owes no read.
   */
  private writeStore(reason: PowerTrackerPersistReason, whole: boolean): boolean {
    const { deps, homeId } = this.params;
    try {
      const writeStart = Date.now();
      const store = deps.getStore();
      if (whole) this.hydrationOwed = false;
      else this.settleOwedHydration();
      if (whole) store.replace(homeId, this.state);
      else store.save(homeId, this.state);
      addPerfDuration('power_tracker_store_write_ms', Date.now() - writeStart);
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
}

export const createHomeTrackerPersistence = (
  params: HomeTrackerPersistenceParams,
): HomeTrackerPersistence => new HomeTrackerPersistenceController(params);
