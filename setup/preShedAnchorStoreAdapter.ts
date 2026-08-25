/**
 * Settings-backed adapter for the pre-shed setpoint anchor port
 * (`lib/plan/preShedAnchor.ts`). Only this file knows the anchors live in
 * Homey settings; the planner and mode-target seeding consume the typed port.
 *
 * Persistence discipline (per-store pattern, `notes/persisted-settings-state.md`
 * — deliberately NOT a shared generic helper, the note's Status cuts that):
 *
 * - **Write-through, no debounce.** Anchors mutate only on shed-decision edges
 *   and releases — a handful of writes per day — and PELS is routinely
 *   OOM-killed, so an `onUninit` flush cannot be the plan of record. Every
 *   accepted mutation persists immediately; a failed write leaves the store
 *   dirty and the next call retries, so dirty clears only on a successful
 *   write.
 * - **Boot read is a discriminated classification**, `loaded | absent |
 *   unreadable` (no catch-all): a readable object loads (malformed ENTRIES are
 *   contract violators and are dropped individually); a missing value is
 *   `absent` only when the written-before marker is unset AND the key list
 *   vouches that neither key was ever written (`homey.settings.get()` answers
 *   an unset key with `null` — classify on both, then cross-check `getKeys()`,
 *   per `setup/AGENTS.md`); everything else — marker set, key listed, keys
 *   unreadable, non-object payload, a thrown read — is `unreadable`.
 * - **Abandon-grace on `unreadable`.** One transient SDK miss on boot must not
 *   wipe persisted anchors: the store answers `unavailable` (consumers decide
 *   nothing — see the port docs), retries the read on every access, and only
 *   after the grace window expires does it abandon the old value and start
 *   empty. `absent` (a genuine fresh install) skips the grace entirely.
 */
import { getLogger } from '../lib/logging/logger';
import { normalizeError } from '../lib/utils/errorUtils';
import { isFiniteNumber } from '../lib/utils/appTypeGuards';
import { PRE_SHED_ANCHORS, PRE_SHED_ANCHORS_INITIALIZED } from '../lib/utils/settingsKeys';
import type {
  PreShedAnchorEntry,
  PreShedAnchorRead,
  PreShedAnchorStore,
} from '../lib/plan/preShedAnchor';

const logger = getLogger('setup/pre-shed-anchor-store');

/** Grace window after an unreadable boot read, mirroring the calibration
 * store's `DEFAULT_LOAD_GRACE_MS`. */
export const PRE_SHED_ANCHOR_LOAD_GRACE_MS = 5 * 60 * 1000;

/** The slice of `homey.settings` this adapter touches. `getKeys` is typed
 * loose on purpose: the reference readers treat the key list itself as
 * untrusted (`readTemperatureControlDisabledDevicesSetting`). */
export type PreShedAnchorSettingsPort = {
  get: (key: string) => unknown;
  set: (key: string, value: unknown) => void;
  getKeys: () => unknown;
};

type AnchorRecord = Record<string, PreShedAnchorEntry>;

type RawClassification =
  | { kind: 'loaded'; record: AnchorRecord }
  | { kind: 'absent' }
  | { kind: 'unreadable' };

type LoadPhase =
  | { phase: 'not_loaded' }
  | { phase: 'suspect'; abandonAtMs: number }
  | { phase: 'loaded' };

function isPreShedAnchorEntry(value: unknown): value is PreShedAnchorEntry {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return isFiniteNumber(candidate.anchorC) && isFiniteNumber(candidate.shedFloorC);
}

class PreShedAnchorStoreAdapter implements PreShedAnchorStore {
  private entries: AnchorRecord = {};
  private loadPhase: LoadPhase = { phase: 'not_loaded' };
  private dirty = false;
  private markerPersisted = false;
  /** Captures deferred while the boot read is suspect — applied record-if-
   * absent once the store loads, so a shed decided during the grace window is
   * not lost and a recovered persisted anchor is never clobbered. First write
   * per device wins (matching capture-on-edge semantics). */
  private pendingCaptures: AnchorRecord = {};

  constructor(
    private readonly getSettings: () => PreShedAnchorSettingsPort,
    private readonly now: () => number,
  ) {}

  read(deviceId: string): PreShedAnchorRead {
    this.ensureReady();
    if (this.loadPhase.phase !== 'loaded') return { kind: 'unavailable' };
    const entry = this.entries[deviceId];
    return entry === undefined ? { kind: 'none' } : { kind: 'anchored', entry };
  }

  record(deviceId: string, entry: PreShedAnchorEntry): void {
    // A capture that BEGAN while the store was unavailable keeps its deferred
    // record-if-absent semantics through the whole operation: `ensureReady`
    // below can recover the blob mid-call, and the caller's decision to
    // record was taken against an `unavailable` read — an unconditional
    // overwrite here would clobber whatever the recovered blob holds for this
    // device, violating the port contract.
    const wasLoadedAtEntry = this.loadPhase.phase === 'loaded';
    this.ensureReady();
    if (this.loadPhase.phase !== 'loaded') {
      // Port contract: a record during the grace window is a deferred
      // record-if-absent. First capture per device wins, matching the
      // planner's first-posture-build capture semantics.
      if (this.pendingCaptures[deviceId] === undefined) {
        this.pendingCaptures[deviceId] = entry;
        logger.info({ event: 'pre_shed_anchor_capture_deferred', deviceId });
      }
      return;
    }
    if (!wasLoadedAtEntry && this.entries[deviceId] !== undefined) {
      logger.info({ event: 'pre_shed_anchor_capture_yielded_to_recovered_entry', deviceId });
      return;
    }
    this.entries[deviceId] = entry;
    logger.info({
      event: 'pre_shed_anchor_recorded',
      deviceId,
      anchorC: entry.anchorC,
      shedFloorC: entry.shedFloorC,
    });
    this.persist();
  }

  retryDirtyPersist(): void {
    // One bounded attempt per plan rebuild (called by the planner's anchor
    // maintenance pass) to land a persist that failed on its mutation. The
    // next mutation may be hours away — often the release-clear itself — and
    // production PELS is routinely OOM-killed, so mutation-only retry could
    // strand an accepted capture memory-only for its whole episode. Reads
    // stay write-free; this is the one sanctioned non-mutation write path.
    // `persist` logs the clean->dirty transition once and retries at debug.
    this.ensureReady();
    if (this.loadPhase.phase !== 'loaded' || !this.dirty) return;
    this.persist();
  }

  clear(deviceId: string): void {
    this.ensureReady();
    if (this.loadPhase.phase !== 'loaded') {
      // Unreachable via the planner (every clear is gated on an `anchored`
      // read, which the suspect phase never answers); refuse rather than
      // decide anything mid-grace.
      logger.warn({ event: 'pre_shed_anchor_clear_refused_during_grace', deviceId });
      return;
    }
    if (this.entries[deviceId] === undefined) return;
    delete this.entries[deviceId];
    logger.info({ event: 'pre_shed_anchor_cleared', deviceId });
    this.persist();
  }

  private ensureReady(): void {
    if (this.loadPhase.phase === 'loaded') return;
    const classified = this.classifyRawRead();
    if (classified.kind === 'loaded') {
      this.entries = classified.record;
      this.markerPersisted = this.readMarker();
      this.loadPhase = { phase: 'loaded' };
      logger.info({
        event: 'pre_shed_anchor_store_loaded',
        deviceCount: Object.keys(classified.record).length,
      });
      this.flushPendingCaptures();
      return;
    }
    if (classified.kind === 'absent') {
      // Genuine fresh install: nothing to protect, first write may proceed.
      this.entries = {};
      this.loadPhase = { phase: 'loaded' };
      this.flushPendingCaptures();
      return;
    }
    if (this.loadPhase.phase === 'not_loaded') {
      this.loadPhase = { phase: 'suspect', abandonAtMs: this.now() + PRE_SHED_ANCHOR_LOAD_GRACE_MS };
      logger.warn({ event: 'pre_shed_anchor_store_read_suspect', graceMs: PRE_SHED_ANCHOR_LOAD_GRACE_MS });
      return;
    }
    if (this.now() >= this.loadPhase.abandonAtMs) {
      this.entries = {};
      this.loadPhase = { phase: 'loaded' };
      logger.warn({ event: 'pre_shed_anchor_store_abandoned_after_grace' });
      this.flushPendingCaptures();
    }
  }

  /** Apply captures deferred during the grace window, record-if-absent: an
   * entry the (recovered) blob already has wins over the deferred one. */
  private flushPendingCaptures(): void {
    const pending = Object.entries(this.pendingCaptures)
      .filter(([deviceId]) => this.entries[deviceId] === undefined);
    this.pendingCaptures = {};
    if (pending.length === 0) return;
    for (const [deviceId, entry] of pending) {
      this.entries[deviceId] = entry;
    }
    logger.info({
      event: 'pre_shed_anchor_deferred_captures_applied',
      deviceIds: pending.map(([deviceId]) => deviceId),
    });
    this.persist();
  }

  private classifyRawRead(): RawClassification {
    try {
      const settings = this.getSettings();
      const raw = settings.get(PRE_SHED_ANCHORS);
      if (typeof raw === 'object' && raw !== null && !Array.isArray(raw)) {
        const entries = Object.entries(raw as Record<string, unknown>)
          .filter((pair): pair is [string, PreShedAnchorEntry] => isPreShedAnchorEntry(pair[1]));
        const droppedCount = Object.keys(raw).length - entries.length;
        if (droppedCount > 0) {
          logger.warn({ event: 'pre_shed_anchor_entries_dropped', droppedCount });
        }
        return { kind: 'loaded', record: Object.fromEntries(entries) };
      }
      if (raw === undefined || raw === null) {
        if (this.readMarker()) return { kind: 'unreadable' };
        const keys = settings.getKeys();
        // An EMPTY key list is itself a suspect read (a real install always
        // has keys), exactly like the reference reader
        // (`readTemperatureControlDisabledDevicesSetting`).
        if (
          Array.isArray(keys)
          && keys.length > 0
          && keys.every((key): key is string => typeof key === 'string')
          && !keys.includes(PRE_SHED_ANCHORS)
          && !keys.includes(PRE_SHED_ANCHORS_INITIALIZED)
        ) {
          return { kind: 'absent' };
        }
      }
      return { kind: 'unreadable' };
    } catch (error) {
      // Log only the boot classification's failure: during the grace window
      // this read retries on every access (~one per temperature device per
      // plan rebuild), and per-retry warns would flood the log while the SDK
      // is down. The suspect/abandoned transitions are logged by the caller.
      if (this.loadPhase.phase === 'not_loaded') {
        logger.warn({ event: 'pre_shed_anchor_store_read_failed', error: normalizeError(error) });
      }
      return { kind: 'unreadable' };
    }
  }

  private readMarker(): boolean {
    try {
      return this.getSettings().get(PRE_SHED_ANCHORS_INITIALIZED) === true;
    } catch {
      return false;
    }
  }

  /**
   * Write-through persistence; a failed write leaves the store dirty and the
   * NEXT MUTATION retries (mutations are the only retry point — reads must
   * stay free of settings writes, they run per temperature device per plan
   * rebuild). Warn once per clean→dirty transition; a still-failing retry
   * logs at debug so a down SDK write path cannot flood the log.
   */
  private persist(): void {
    const wasDirty = this.dirty;
    try {
      const settings = this.getSettings();
      settings.set(PRE_SHED_ANCHORS, { ...this.entries });
      if (!this.markerPersisted) {
        settings.set(PRE_SHED_ANCHORS_INITIALIZED, true);
        this.markerPersisted = true;
      }
      this.dirty = false;
    } catch (error) {
      this.dirty = true;
      if (wasDirty) {
        logger.debug({ event: 'pre_shed_anchor_persist_retry_failed', error: normalizeError(error) });
      } else {
        logger.warn({ event: 'pre_shed_anchor_persist_failed', error: normalizeError(error) });
      }
    }
  }
}

/** Factory per setup conventions; `getSettings`/`now` are lazy so the adapter
 * can be constructed as an app field before `onInit`. */
export function createPreShedAnchorStore(
  getSettings: () => PreShedAnchorSettingsPort,
  now: () => number,
): PreShedAnchorStore {
  return new PreShedAnchorStoreAdapter(getSettings, now);
}
