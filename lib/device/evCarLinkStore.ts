/**
 * Persistence wiring for the EV car-to-charger link probe.
 *
 * Deliberately parallel to `devicePowerCalibrationStore.ts` rather than sharing
 * a helper with it — `notes/persisted-settings-state.md` cut the shared
 * `PersistedSettingsState<T>` proposal, because the stores share vocabulary
 * (dirty/debounce/flush) but not semantics. What IS copied is the hard-won
 * decision table that store accumulated over four review rounds:
 *
 *  - an `_INITIALIZED` marker distinguishes a genuine fresh install from a
 *    transient settings read miss, so the first persist after an unreadable
 *    startup cannot overwrite real history;
 *  - a thrown read forces the cautious branch, never the fresh-install branch;
 *  - `snapshotForPersist` honours debounce AND load-grace, `snapshotForFlush`
 *    honours load-grace only, and neither clears `dirty` — the caller commits
 *    with `markPersisted` only after the write actually succeeded.
 *
 * Losing this state is not a correctness problem for the probe (votes simply
 * re-accumulate), but wiping it would silently reset the observed-charge-limit
 * samples, which is exactly the multi-session evidence the probe exists to
 * gather.
 */
import type { EvCarLinkSnapshot } from '../../packages/contracts/src/evCarLink';
import type { HomeyRuntime } from '../ports/homeyRuntime';
import { EV_CAR_LINK_STATE, EV_CAR_LINK_STATE_INITIALIZED } from '../utils/settingsKeys';
import { getLogger } from '../logging/logger';
import { normalizeError } from '../utils/errorUtils';
import {
    createEmptyEvCarLinkSnapshot,
    isStrictlyValidPersistedEvCarLink,
    mergeRecoveredEvCarLinkHistory,
    normalizeEvCarLinkSnapshot,
    pruneEvCarLinkSnapshot,
} from './evCarLinkSnapshot';

const moduleLogger = getLogger('device/ev-car-link-store');

const DEFAULT_PERSIST_DEBOUNCE_MS = 60_000;
const DEFAULT_LOAD_GRACE_MS = 5 * 60 * 1000;
/**
 * How long a *transient-miss* recovery re-read (SDK answering, value absent,
 * init marker present) may keep deferring the first write, measured from the
 * FIRST deferred attempt — not from boot, so a store whose first vote arrives
 * hours later still gets a full window of spaced re-reads instead of
 * abandoning on a single one. Past the deadline the value has been absent
 * across spaced re-reads and writing over an absent key destroys nothing. A
 * *thrown* re-read never uses this deadline — it defers indefinitely, because
 * every retry re-reads and a healed SDK then recovers the history. Mirrors
 * `devicePowerCalibrationStore.ts`.
 */
const DEFAULT_RECOVERY_DEFERRAL_MS = 5 * 60 * 1000;

export type EvCarLinkStoreOptions = {
    initialSnapshot?: EvCarLinkSnapshot;
    persistDebounceMs?: number;
    /** Positive when the persisted value was absent/malformed on load. */
    loadGraceMs?: number;
    /** Construction time. Defaults to `Date.now()`. */
    nowMs?: number;
};

/**
 * What a recovery re-read of the persisted snapshot established, applied by
 * the private settle step of {@link EvCarLinkStore.resolveRecoveryForWrite}.
 */
type RecoveredEvCarLinkHistory =
    | { kind: 'recovered'; snapshot: EvCarLinkSnapshot }
    | { kind: 'nothing_recoverable' };

/**
 * Outcome of settling the boot-time recovery re-read ahead of a write.
 * `ready` carries the snapshot to persist (merged when history was
 * recovered); `deferred` means the persisted value may still be recoverable
 * but was not readable right now, so this write must not happen — the store
 * stays dirty and the persist guard retries, re-reading each time.
 */
type RecoveryWriteResolution =
    | { kind: 'ready'; snapshot: EvCarLinkSnapshot }
    | { kind: 'deferred' };

/** In-memory cache with a dirty flag, a debounce window, and a load-grace gate. */
export class EvCarLinkStore {
    private snapshot: EvCarLinkSnapshot;
    private dirty = false;
    private lastPersistMs = 0;
    private recoveryPending: boolean;
    /** Throttle cursor for recovery re-reads; sentinel = never attempted. */
    private lastRecoveryAttemptMs = Number.NEGATIVE_INFINITY;
    /**
     * Per-arm deferral windows, each armed by that arm's FIRST deferred
     * attempt; 0 = not armed yet. They must stay separate: a long thrown
     * phase that healed into a transiently-absent read would otherwise hand
     * the transient-miss arm an already-expired shared window, abandoning
     * recovery after ZERO spaced absent re-reads — the exact overwrite this
     * machinery exists to prevent.
     */
    private readThrewDeferralUntilMs = 0;
    private transientMissDeferralUntilMs = 0;
    private readonly persistDebounceMs: number;
    private readonly persistGraceUntilMs: number;

    constructor(options: EvCarLinkStoreOptions = {}) {
        this.snapshot = options.initialSnapshot ?? createEmptyEvCarLinkSnapshot();
        this.persistDebounceMs = options.persistDebounceMs ?? DEFAULT_PERSIST_DEBOUNCE_MS;
        const graceMs = options.loadGraceMs ?? 0;
        this.persistGraceUntilMs = graceMs > 0 ? (options.nowMs ?? Date.now()) + graceMs : 0;
        // A grace window engages exactly when the boot read was suspect, so the
        // same signal marks the persisted value as still worth a recovery
        // re-read before the first write is allowed to overwrite it.
        this.recoveryPending = this.persistGraceUntilMs > 0;
    }

    getSnapshot(): EvCarLinkSnapshot {
        return this.snapshot;
    }

    /** Accept a new snapshot from the producer; marks the store dirty. */
    setSnapshot(snapshot: EvCarLinkSnapshot): void {
        if (snapshot === this.snapshot) return;
        this.snapshot = snapshot;
        this.dirty = true;
    }

    /** Drop records untouched for longer than the prune window. */
    prune(nowMs: number): boolean {
        const next = pruneEvCarLinkSnapshot({ snapshot: this.snapshot, nowMs });
        if (next === this.snapshot) return false;
        this.snapshot = next;
        this.dirty = true;
        return true;
    }

    /** Dirty AND past both the debounce and load-grace gates. Non-mutating. */
    snapshotForPersist(nowMs: number): EvCarLinkSnapshot | null {
        if (!this.dirty) return null;
        if (nowMs < this.persistGraceUntilMs) return null;
        if ((nowMs - this.lastPersistMs) < this.persistDebounceMs) return null;
        return this.snapshot;
    }

    /**
     * Dirty and past the load-grace gate, bypassing debounce only. The grace is
     * still honoured: flushing inside it would write a possibly-incomplete
     * in-memory state over history that was merely unreadable at startup.
     */
    snapshotForFlush(nowMs: number): EvCarLinkSnapshot | null {
        if (!this.dirty) return null;
        if (nowMs < this.persistGraceUntilMs) return null;
        return this.snapshot;
    }

    /**
     * Resolve the pending recovery re-read before the first post-grace write.
     * The abandon-grace window blocks writes while a transiently unreadable
     * boot read might still recover, but blocking alone only postpones the
     * overwrite — this re-read is what actually recovers the value. Same
     * decision table as `devicePowerCalibrationStore.ts`: value present →
     * merge and write; absent with no marker → write; absent with marker →
     * defer until a bounded window armed by that arm's first deferred
     * attempt, then write; re-read threw → defer with no deadline (every
     * retry re-reads, so a healed SDK recovers the history), escalating the
     * log to warn past its own window.
     *
     * This is the ONLY seam over the recovery state machine, and only the
     * write path (`writeAndMark`, via `persistEvCarLinkIfDue` /
     * `persistEvCarLinkFlush`) may call it: the throttle, the deferral
     * windows, and the settle step are private precisely so no other caller
     * can settle recovery without performing the re-read — settling from
     * outside would silently disarm first-write protection.
     */
    resolveRecoveryForWrite(
        params: { homey: HomeyRuntime; nowMs: number },
        snapshot: EvCarLinkSnapshot,
    ): RecoveryWriteResolution {
        if (!this.recoveryPending) return { kind: 'ready', snapshot };
        // Rate-limit: without this gate the deferral path re-reads and logs
        // on every accepted vote for as long as the SDK stays broken.
        if (!this.beginRecoveryAttempt(params.nowMs)) return { kind: 'deferred' };
        const reread = readPersistedSnapshot(params.homey);
        if (!reread.threw && reread.value !== undefined && reread.value !== null) {
            // Prune mirrors the load path: the recovered value skipped
            // prune-on-load when the boot read failed, and nothing else ever
            // prunes this store.
            const recovered = pruneEvCarLinkSnapshot({
                snapshot: normalizeEvCarLinkSnapshot(reread.value, params.nowMs),
                nowMs: params.nowMs,
            });
            this.settleRecovery({ kind: 'recovered', snapshot: recovered });
            moduleLogger.info({
                event: 'ev_car_link_recovery_merged',
                recoveredPairs: Object.keys(recovered.pairs).length,
                recoveredCars: Object.keys(recovered.cars).length,
            });
            return { kind: 'ready', snapshot: this.snapshot };
        }
        if (!reread.threw) {
            const markerRead = readInitMarker(params.homey);
            const markerPresent = markerRead.threw ? true : markerRead.value;
            if (!markerPresent) {
                // Absent value and no we've-written-before marker: nothing was
                // ever (or is any longer) persisted — nothing to recover.
                this.settleRecovery({ kind: 'nothing_recoverable' });
                return { kind: 'ready', snapshot };
            }
            if (this.noteRecoveryDeferred(params.nowMs, 'transient_miss') === 'past_window') {
                this.settleRecovery({ kind: 'nothing_recoverable' });
                moduleLogger.warn({ event: 'ev_car_link_recovery_abandoned' });
                return { kind: 'ready', snapshot };
            }
            moduleLogger.info({
                event: 'ev_car_link_recovery_write_deferred',
                reason: 'transient_miss',
            });
            return { kind: 'deferred' };
        }
        const deferredPayload = {
            event: 'ev_car_link_recovery_write_deferred',
            reason: 'read_threw',
        };
        if (this.noteRecoveryDeferred(params.nowMs, 'read_threw') === 'past_window') {
            moduleLogger.warn(deferredPayload);
        } else {
            moduleLogger.info(deferredPayload);
        }
        return { kind: 'deferred' };
    }

    /**
     * Throttle gate for recovery re-reads: at most one attempt per persist
     * debounce window. Records the attempt when it admits one.
     */
    private beginRecoveryAttempt(nowMs: number): boolean {
        if (nowMs - this.lastRecoveryAttemptMs < this.persistDebounceMs) return false;
        this.lastRecoveryAttemptMs = nowMs;
        return true;
    }

    /**
     * Record that a recovery attempt could not read the persisted value and
     * had to defer the write. The first call for an arm arms THAT arm's
     * deferral window; the answer says whether it has since elapsed. The
     * *transient-miss* arm abandons recovery on `past_window` (the value has
     * been absent across its own spaced re-reads and writing over an absent
     * key destroys nothing); the *thrown* arm never abandons and uses
     * `past_window` only to escalate its log level, so a permanent read stall
     * is visible to log triage.
     */
    private noteRecoveryDeferred(
        nowMs: number,
        arm: 'read_threw' | 'transient_miss',
    ): 'within_window' | 'past_window' {
        if (arm === 'read_threw') {
            if (this.readThrewDeferralUntilMs === 0) {
                this.readThrewDeferralUntilMs = nowMs + DEFAULT_RECOVERY_DEFERRAL_MS;
            }
            return nowMs < this.readThrewDeferralUntilMs ? 'within_window' : 'past_window';
        }
        if (this.transientMissDeferralUntilMs === 0) {
            this.transientMissDeferralUntilMs = nowMs + DEFAULT_RECOVERY_DEFERRAL_MS;
        }
        return nowMs < this.transientMissDeferralUntilMs ? 'within_window' : 'past_window';
    }

    /**
     * Settle the recovery re-read. `recovered` merges the re-read history under
     * the in-memory accepted state (in-memory wins per key; recovered fills
     * everything else); `nothing_recoverable` records that the persisted value
     * is genuinely gone. Leaves the dirty flag as-is in both arms.
     */
    private settleRecovery(outcome: RecoveredEvCarLinkHistory): void {
        if (outcome.kind === 'recovered') {
            this.snapshot = mergeRecoveredEvCarLinkHistory({
                inMemory: this.snapshot,
                recovered: outcome.snapshot,
            });
        }
        this.recoveryPending = false;
    }

    /** Only after a durable write — a premature call silently drops buffered votes. */
    markPersisted(nowMs: number): void {
        this.dirty = false;
        this.lastPersistMs = nowMs;
    }

    isDirty(): boolean {
        return this.dirty;
    }
}

type SettingsReadResult<T> = { value: T; threw: false } | { value: undefined; threw: true };

const readPersistedSnapshot = (homey: HomeyRuntime): SettingsReadResult<unknown> => {
    try {
        return { value: homey.settings.get(EV_CAR_LINK_STATE), threw: false };
    } catch {
        return { value: undefined, threw: true };
    }
};

const readInitMarker = (homey: HomeyRuntime): SettingsReadResult<boolean> => {
    try {
        return { value: homey.settings.get(EV_CAR_LINK_STATE_INITIALIZED) === true, threw: false };
    } catch {
        return { value: undefined, threw: true };
    }
};

const writeInitMarkerBestEffort = (homey: HomeyRuntime): void => {
    try {
        homey.settings.set(EV_CAR_LINK_STATE_INITIALIZED, true);
    } catch (error) {
        moduleLogger.debug({ event: 'ev_car_link_init_marker_write_failed', err: normalizeError(error) });
    }
};

/**
 * Decide whether to engage the abandon-grace window after loading.
 *  - Plausible raw → no grace; the loaded snapshot is authoritative.
 *  - Raw read threw → engage grace regardless of the marker. The SDK refused to
 *    answer, and an upgrading install may legitimately have no marker yet.
 *  - Raw absent AND marker absent → fresh install; no grace.
 *  - Raw absent AND marker present → transient miss; engage grace.
 *  - Raw malformed → engage grace; partial corruption must not be overwritten.
 */
const resolveLoadGraceMs = (args: {
    rawIsPlausible: boolean;
    rawIsAbsent: boolean;
    hasInitMarker: boolean;
}): number => {
    if (args.rawIsPlausible) return 0;
    if (args.rawIsAbsent && !args.hasInitMarker) return 0;
    return DEFAULT_LOAD_GRACE_MS;
};

/**
 * Load the store from Homey settings. Missing, malformed, and thrown reads all
 * resolve to an empty in-memory snapshot rather than propagating — with the
 * grace window engaged wherever prior history might still be recoverable.
 */
export const loadEvCarLinkStore = (params: {
    homey: HomeyRuntime;
    options?: EvCarLinkStoreOptions;
}): EvCarLinkStore => {
    const rawRead = readPersistedSnapshot(params.homey);
    // Prune on load rather than on a timer: the only way pair records accumulate
    // is device churn across restarts, so boot is exactly when stale ones appear
    // and the cheapest moment to drop them. Without this the advertised 90-day
    // retention never applies and the settings blob grows with every replaced
    // car or charger.
    const loadedAtMs = params.options?.nowMs ?? Date.now();
    const initialSnapshot = pruneEvCarLinkSnapshot({
        snapshot: normalizeEvCarLinkSnapshot(rawRead.value, loadedAtMs),
        nowMs: loadedAtMs,
    });
    const rawIsPlausible = !rawRead.threw && isStrictlyValidPersistedEvCarLink(rawRead.value);
    const rawIsAbsent = !rawRead.threw && (rawRead.value === undefined || rawRead.value === null);
    const markerRead = readInitMarker(params.homey);
    // A thrown marker read counts as marker-present: pairing it with an absent
    // snapshot would otherwise misclassify an existing install as fresh and skip
    // the grace window — the data-loss case the marker exists to prevent.
    const hasInitMarker = markerRead.threw ? true : markerRead.value;
    if (rawIsPlausible && !markerRead.threw && !markerRead.value) {
        writeInitMarkerBestEffort(params.homey);
    }
    const loadGraceMs = params.options?.loadGraceMs
        ?? resolveLoadGraceMs({ rawIsPlausible, rawIsAbsent, hasInitMarker });
    return new EvCarLinkStore({ ...(params.options ?? {}), initialSnapshot, loadGraceMs });
};

const writeAndMark = (params: {
    homey: HomeyRuntime;
    store: EvCarLinkStore;
    nowMs: number;
}, snapshot: EvCarLinkSnapshot): boolean => {
    const resolution = params.store.resolveRecoveryForWrite(
        { homey: params.homey, nowMs: params.nowMs },
        snapshot,
    );
    if (resolution.kind === 'deferred') return false;
    try {
        params.homey.settings.set(EV_CAR_LINK_STATE, resolution.snapshot);
        params.homey.settings.set(EV_CAR_LINK_STATE_INITIALIZED, true);
        params.store.markPersisted(params.nowMs);
        return true;
    } catch (error) {
        // Stay dirty so the next tick retries the same state.
        moduleLogger.error({ event: 'ev_car_link_persist_failed', err: normalizeError(error) });
        return false;
    }
};

/** Persist when dirty and past the debounce + grace gates. Safe on a heartbeat. */
export const persistEvCarLinkIfDue = (params: {
    homey: HomeyRuntime;
    store: EvCarLinkStore;
    nowMs: number;
}): boolean => {
    const snapshot = params.store.snapshotForPersist(params.nowMs);
    if (!snapshot) return false;
    return writeAndMark(params, snapshot);
};

/** Persist regardless of debounce (grace still honoured). For shutdown/prune. */
export const persistEvCarLinkFlush = (params: {
    homey: HomeyRuntime;
    store: EvCarLinkStore;
    nowMs: number;
}): boolean => {
    const snapshot = params.store.snapshotForFlush(params.nowMs);
    if (!snapshot) return false;
    return writeAndMark(params, snapshot);
};
