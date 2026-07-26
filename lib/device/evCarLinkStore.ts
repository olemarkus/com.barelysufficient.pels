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
    normalizeEvCarLinkSnapshot,
    pruneEvCarLinkSnapshot,
} from './evCarLinkSnapshot';

const moduleLogger = getLogger('device/ev-car-link-store');

const DEFAULT_PERSIST_DEBOUNCE_MS = 60_000;
const DEFAULT_LOAD_GRACE_MS = 5 * 60 * 1000;

export type EvCarLinkStoreOptions = {
    initialSnapshot?: EvCarLinkSnapshot;
    persistDebounceMs?: number;
    /** Positive when the persisted value was absent/malformed on load. */
    loadGraceMs?: number;
    /** Construction time. Defaults to `Date.now()`. */
    nowMs?: number;
};

/** In-memory cache with a dirty flag, a debounce window, and a load-grace gate. */
export class EvCarLinkStore {
    private snapshot: EvCarLinkSnapshot;
    private dirty = false;
    private lastPersistMs = 0;
    private readonly persistDebounceMs: number;
    private readonly persistGraceUntilMs: number;

    constructor(options: EvCarLinkStoreOptions = {}) {
        this.snapshot = options.initialSnapshot ?? createEmptyEvCarLinkSnapshot();
        this.persistDebounceMs = options.persistDebounceMs ?? DEFAULT_PERSIST_DEBOUNCE_MS;
        const graceMs = options.loadGraceMs ?? 0;
        this.persistGraceUntilMs = graceMs > 0 ? (options.nowMs ?? Date.now()) + graceMs : 0;
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
    const initialSnapshot = normalizeEvCarLinkSnapshot(rawRead.value);
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
    try {
        params.homey.settings.set(EV_CAR_LINK_STATE, snapshot);
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
