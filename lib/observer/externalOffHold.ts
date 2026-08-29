/**
 * Owns the **external-off hold**: the per-device state recording that an opted-in
 * device was turned off outside PELS, independent of the current plan, and that
 * PELS must therefore leave it off until it is turned on again.
 *
 * Ownership split:
 *  - **This module** owns the hold state, the opt-in read, and persistence. It is
 *    a pure observer leaf (`no-observer-to-peer`): no imports at all, so
 *    `lib/device`, `lib/plan`, `lib/executor`, and `setup` may all depend on it.
 *  - **`setup/externalOffHoldAdapter.ts`** binds the two settings keys to the
 *    `load`/`save`/`readOptIn` seams below. It knows Homey; this module does not.
 *  - **`setup/externalOffHoldDetection.ts`** owns the provenance question ("was
 *    this OFF ours?"). This module never asks why a device is off.
 *  - **`setup/appInit/toPlanDevice.ts`** resolves the stored hold against live
 *    observed state into the flat `externalOffHoldActive` plan-input bit.
 *
 * Invariants callers may rely on:
 *  - `load` never throws and never wipes. An absent, malformed, or throwing read
 *    yields an empty in-memory map AND engages an abandon-grace window during
 *    which nothing is persisted — otherwise the next mutation for any device
 *    would full-replace the setting and erase every other device's hold. A fresh
 *    install (no marker) skips the grace, so the first real hold persists at once.
 *    Per `feedback_homey_sdk_unreliable` / `notes/persisted-settings-state.md`.
 *  - **Unavailable is not "no holds".** An unreadable state must not answer
 *    `isHeld === false`, because that answer IS the resume this feature exists to
 *    prevent. While unavailable the read is re-attempted on access and `isHeld`
 *    fails closed for opted-in devices. Every consumer pairs `isHeld` with "still
 *    observed off", so a device that is actually running is never affected.
 *  - A mutation the grace window (or a throwing `save`) kept out of the store is
 *    retained and flushed on a later access. Repeating the same `startHold` is a
 *    no-op, so without this a transient failure would silently lose the hold.
 *    Releases get the same durability: a `clearHold` whose deletion could not
 *    land on the unreadable map is tombstoned, and — for a device the blob
 *    could actually hold — kept as a pending write across grace expiry, so a
 *    reconciling read-merge or write eventually lands and a restart cannot
 *    reload the stale persisted hold and strand a device the user released.
 *  - A corrupt individual entry is skipped, not fatal, and entries are rebuilt
 *    field-by-field on load so a tampered blob cannot smuggle extra keys through
 *    into the next write.
 *  - Writes are dirty-gated: an unchanged mutation performs no settings write.
 *    Homey settings writes are synchronous, so per-observation writes would
 *    thrash flash.
 *  - Entries are never pruned on snapshot absence. There is no device-removal
 *    grace in the codebase today, and a single failed snapshot must not release a
 *    hold; a stale entry for a removed device is inert and bounded by device count.
 *
 * The persistence shape here deliberately duplicates
 * `lib/objectives/deferredObjectives/hoursRemainingCrossings.ts` rather than
 * sharing a helper: `notes/persisted-settings-state.md` cut the shared
 * `PersistedSettingsState<T>` proposal in the 2026-05-31 layering review, because
 * the stores share vocabulary but not semantics. Do not re-raise it.
 */

/**
 * One active hold. `sinceMs` is when it began — the only field with a reader
 * (diagnostics/logging). The spec's suggested `observedAtMs`/`capabilityId` are
 * deliberately absent: nothing advances or reads them, and an unread persisted
 * field is a shape that can only drift. Add them with the surface that needs them.
 */
export type ExternalOffHoldEntry = {
  sinceMs: number;
};

/**
 * Persisted shape. `version` is bumped when the shape changes; the validator
 * rejects anything else so a tampered or downgraded payload is treated as
 * missing rather than smuggled past type checks.
 */
export type PersistedExternalOffHolds = {
  version: 1;
  entriesByDeviceId: Record<string, ExternalOffHoldEntry>;
};

export const EXTERNAL_OFF_HOLD_VERSION = 1 as const;

/**
 * How long to refuse persistence after a load that produced no usable state
 * while the marker says we have written before. Long enough to cover a transient
 * SDK read failure and a following recovery read; the in-memory map stays
 * authoritative meanwhile. Mirrors `devicePowerCalibrationStore`'s window.
 */
export const EXTERNAL_OFF_HOLD_LOAD_GRACE_MS = 5 * 60 * 1000;

/**
 * How long to wait before re-attempting a read that came back unavailable. Short
 * enough that a transient SDK failure clears well inside the first plan cycle,
 * long enough that a persistently broken read costs one settings call per 10 s
 * rather than one per device per cycle.
 */
export const EXTERNAL_OFF_HOLD_RELOAD_RETRY_MS = 10 * 1000;

/**
 * The opt-in read as a typed semantic result: "nobody opted in" and "the map
 * could not be read" are different answers and the adapter owns the distinction
 * (the boundary rule in `AGENTS.md`). Collapsing them is a wipe — at construction
 * an unavailable read would make every restored hold look de-opted, and
 * `releaseDeOptedHolds` would clear and persist an empty map.
 */
export type ExternalOffHoldOptInRead =
  | { status: 'resolved'; optIn: Record<string, boolean> }
  | { status: 'unavailable' };

export type ExternalOffHoldDeps = {
  load?: () => unknown;
  save?: (holds: PersistedExternalOffHolds) => void;
  /**
   * Reads the per-device opt-in map. Called live rather than cached so a
   * just-toggled setting takes effect immediately; it is only reached once per
   * candidate observation, never per device per plan cycle.
   */
  readOptIn?: () => ExternalOffHoldOptInRead;
  /** True once PELS has persisted holds before — distinguishes a fresh install
   *  from a transient read miss. Absent ⇒ treated as a fresh install. */
  hasWrittenBefore?: () => boolean;
  nowMs?: () => number;
};

/**
 * The single surface every consumer types against. Pairs the two *separate*
 * persisted concepts — configuration (`isEnabledForDevice`) and runtime state
 * (`isHeld`) — behind one read surface, because every consumer needs both while
 * neither may ask *why* a hold exists.
 */
export type ExternalOffHoldPolicy = {
  isEnabledForDevice: (deviceId: string) => boolean;
  isHeld: (deviceId: string) => boolean;
  /** Starts a hold. Returns `true` only when one was newly created. */
  startHold: (deviceId: string) => boolean;
  /** Clears a hold. Returns `true` only when one was actually present. */
  clearHold: (deviceId: string) => boolean;
  heldDeviceIds: () => string[];
  /**
   * Drops any hold whose device is no longer opted in. Returns the released
   * device ids. Run at construction as well as on a settings change, so an
   * opt-in cleared while the app was down cannot leave a hold honoured forever.
   */
  releaseDeOptedHolds: () => string[];
};

const isFinitePositive = (value: unknown): value is number => (
  typeof value === 'number' && Number.isFinite(value) && value > 0
);

/**
 * Validates the persisted payload against the v1 shape and rebuilds each entry
 * field-by-field, so unknown keys in a tampered blob are dropped rather than
 * round-tripped into the next write. Returns `null` for anything unusable.
 */
const parsePersistedHolds = (raw: unknown): PersistedExternalOffHolds | null => {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const candidate = raw as Partial<PersistedExternalOffHolds>;
  if (candidate.version !== EXTERNAL_OFF_HOLD_VERSION) return null;
  if (!candidate.entriesByDeviceId
    || typeof candidate.entriesByDeviceId !== 'object'
    || Array.isArray(candidate.entriesByDeviceId)) {
    return null;
  }
  const entries = Object.entries(candidate.entriesByDeviceId)
    .filter(([deviceId, entry]) => (
      deviceId.length > 0 && isFinitePositive((entry as ExternalOffHoldEntry | undefined)?.sinceMs)
    ))
    .map(([deviceId, entry]): [string, ExternalOffHoldEntry] => (
      [deviceId, { sinceMs: entry.sinceMs }]
    ));
  return {
    version: EXTERNAL_OFF_HOLD_VERSION,
    entriesByDeviceId: Object.fromEntries(entries),
  };
};

const serializeHolds = (
  holds: Map<string, ExternalOffHoldEntry>,
): PersistedExternalOffHolds => ({
  version: EXTERNAL_OFF_HOLD_VERSION,
  entriesByDeviceId: Object.fromEntries(holds.entries()),
});

type LoadResult = {
  holds: Map<string, ExternalOffHoldEntry>;
  /**
   * True when the read produced no usable state despite having written before —
   * i.e. the persisted state is *unknown*, not empty. Blocks persistence and
   * makes `isHeld` fail closed until a later read resolves it.
   */
  unavailable: boolean;
};

const loadPersistedHolds = (deps: ExternalOffHoldDeps): LoadResult => {
  const holds = new Map<string, ExternalOffHoldEntry>();
  if (!deps.load) return { holds, unavailable: false };
  let raw: unknown;
  let threw = false;
  try {
    raw = deps.load();
  } catch {
    threw = true;
  }
  const parsed = threw ? null : parsePersistedHolds(raw);
  if (parsed) {
    for (const [deviceId, entry] of Object.entries(parsed.entriesByDeviceId)) {
      holds.set(deviceId, entry);
    }
    return { holds, unavailable: false };
  }
  // Nothing usable came back. If PELS has written holds before, this is a
  // transient miss or a corrupt payload — refuse to persist for a while so the
  // next mutation cannot full-replace the setting with an empty map and erase
  // every other device's hold. On a fresh install there is nothing to protect.
  const wroteBefore = deps.hasWrittenBefore?.() === true;
  const absent = !threw && (raw === undefined || raw === null);
  return { holds, unavailable: wroteBefore || !absent };
};

export const createExternalOffHoldPolicy = (
  deps: ExternalOffHoldDeps = {},
): ExternalOffHoldPolicy => {
  const now = deps.nowMs ?? Date.now;
  const { holds: holdsByDeviceId, unavailable: initiallyUnavailable } = loadPersistedHolds(deps);
  const persistBlockedUntilMs = initiallyUnavailable
    ? now() + EXTERNAL_OFF_HOLD_LOAD_GRACE_MS
    : 0;
  // The persisted state is unknown — NOT empty. Reads fail closed and writes are
  // withheld until a retry resolves it or the grace window expires.
  let stateUnavailable = initiallyUnavailable;
  let nextReloadAtMs = now() + EXTERNAL_OFF_HOLD_RELOAD_RETRY_MS;
  // A mutation the grace window or a throwing `save` kept out of the store.
  let unpersistedMutation = false;
  // True from grace expiry until a read or write reconciles the persisted blob.
  // Expiry makes the in-memory map authoritative WITHOUT the blob ever having
  // been read, so a release that lands on nothing in the map may still be
  // recorded in the blob — only a reconciling read-merge or full-replace write
  // settles the difference, and until one does, `clearHold` must keep
  // tombstoning (see there). Deliberately not a wipe licence: the abandoned
  // blob is left in place so a restart can still recover the holds nobody
  // touched.
  let blobAbandonedUnreconciled = false;
  // Devices released while the persisted state was unknown (unavailable, or
  // abandoned unread after grace expiry), so the deletion could not land on a
  // map we did not have. Replayed against a recovered read — and, for a device
  // the blob could actually hold, carried as a pending write so the release
  // still lands durably when the read never recovers (see `clearHold`). Spent
  // only by the reconcile itself: a successful read-merge or a successful save.
  const releasedWhileUnavailable = new Set<string>();

  const readOptIn = (): ExternalOffHoldOptInRead => (
    deps.readOptIn?.() ?? { status: 'resolved', optIn: {} }
  );

  const isEnabledForDevice = (deviceId: string): boolean => {
    const read = readOptIn();
    return read.status === 'resolved' && read.optIn[deviceId] === true;
  };

  /**
   * Whether a persisted blob we could not read might hold this device. This is
   * the fail-closed guess `isHeld` answers while the state is unavailable, and
   * the gate for treating a tombstoned clear as a pending write: an unresolved
   * opt-in read cannot rule any device out, so every device stays in.
   */
  const mayBeHeldInUnreadBlob = (deviceId: string): boolean => {
    const read = readOptIn();
    return read.status !== 'resolved' || read.optIn[deviceId] === true;
  };

  const flushPendingWrite = (): void => {
    if (!unpersistedMutation || !deps.save) return;
    if (stateUnavailable && now() < persistBlockedUntilMs) return;
    try {
      deps.save(serializeHolds(holdsByDeviceId));
      unpersistedMutation = false;
      // The blob now equals the map: every release recorded against a blob we
      // could not read has been applied durably, so no reconciling write is
      // owed any more and a restart has no stale blob to resurrect holds from.
      blobAbandonedUnreconciled = false;
      // While the state is still unavailable the tombstones stay, though: they
      // are what keeps `isHeld` from re-guessing "held" for a device the user
      // just released, until a recovered read or grace expiry settles the state.
      if (!stateUnavailable) releasedWhileUnavailable.clear();
    } catch {
      // Stay pending and retry on the next access. A permanent failure degrades
      // to in-memory-only, which beats crashing the observation path.
    }
  };

  // Persist only when the map actually changed; a pending write survives the
  // grace window and a failing `save`, because repeating the same `startHold` is
  // a no-op and would otherwise lose the hold at the next restart.
  const applyMutation = (mutate: () => boolean): boolean => {
    if (!mutate()) return false;
    unpersistedMutation = true;
    flushPendingWrite();
    return true;
  };

  const dropDeOptedHolds = (): string[] => {
    // Nothing held ⇒ nothing to reconcile, and no reason to spend a settings
    // read. This is the case for everyone who has not opted a device in.
    if (holdsByDeviceId.size === 0) return [];
    const read = readOptIn();
    // An unavailable opt-in read is not "nobody opted in". Releasing on it would
    // clear — and persist — every restored hold, permanently resuming devices the
    // user turned off. Skip; the next call reconciles once the read resolves.
    if (read.status !== 'resolved') return [];
    return Array.from(holdsByDeviceId.keys())
      .filter((deviceId) => read.optIn[deviceId] !== true)
      .filter((deviceId) => applyMutation(() => holdsByDeviceId.delete(deviceId)));
  };

  /**
   * Merge a recovered read under what happened while it was unavailable.
   *
   * Releases have to be replayed, not just holds. A clear that arrived while the
   * map was empty was a no-op, so without a tombstone the recovered read would
   * resurrect a hold the user had already ended — and if PELS legitimately
   * limited the device in between, it is off again, so the observed-ON pull sweep
   * will never clear it either. That strands exactly the device this feature is
   * supposed to hand back.
   */
  const adoptReloadedHolds = (reloaded: Map<string, ExternalOffHoldEntry>): void => {
    const changedMeanwhile = holdsByDeviceId.size > 0 || releasedWhileUnavailable.size > 0;
    for (const [deviceId, entry] of reloaded) {
      if (releasedWhileUnavailable.has(deviceId)) continue;
      if (!holdsByDeviceId.has(deviceId)) holdsByDeviceId.set(deviceId, entry);
    }
    releasedWhileUnavailable.clear();
    stateUnavailable = false;
    // A read reconciled the blob. When this recovery arrives only after grace
    // expiry, the union revives holds the bounded abandon had dropped — that is
    // restart-equivalent (the blob would have been loaded then anyway), and
    // every consumer pairs `isHeld` with "still observed off".
    blobAbandonedUnreconciled = false;
    // The union differs from what is stored, so it has to be written back.
    if (changedMeanwhile) unpersistedMutation = true;
    dropDeOptedHolds();
  };

  /**
   * Re-attempt an unavailable read, then flush anything that was withheld. Driven
   * from every read and write, so recovery needs no timer and no scheduler.
   * Reload attempts continue past grace expiry for as long as a tombstoned
   * release is outstanding: a successful read lets the reconcile be a surgical
   * merge (keeping every hold the release did not touch) instead of the
   * full-replace write, which remains the fallback when only `save` recovers.
   */
  const settleState = (): void => {
    // A reconcile is owed when a pending write would land on a blob that has
    // never been read since its content last mattered (still unavailable past
    // grace, or abandoned at expiry). The flush below runs on EVERY access
    // while the reload path is throttled, so without a read-before-save order
    // a recovering service is a race the blind save usually wins — it would
    // full-replace the blob with the never-read in-memory map and durably
    // erase every hold the blob still recorded, defeating the restart
    // recovery the abandon deliberately leaves possible. Reading un-throttled
    // right before that flush turns a healed read into the surgical merge;
    // the full replace remains only for a store whose read never heals.
    const reconcileOwed = unpersistedMutation
      && (blobAbandonedUnreconciled || (stateUnavailable && now() >= persistBlockedUntilMs));
    const reloadWorthwhile = stateUnavailable || releasedWhileUnavailable.size > 0;
    if (reconcileOwed || (reloadWorthwhile && now() >= nextReloadAtMs)) {
      nextReloadAtMs = now() + EXTERNAL_OFF_HOLD_RELOAD_RETRY_MS;
      const reloaded = loadPersistedHolds(deps);
      if (!reloaded.unavailable) adoptReloadedHolds(reloaded.holds);
      // Grace expired with the read still broken: stop failing closed and
      // accept the in-memory map as authoritative, matching the bounded
      // abandon-grace contract in `notes/persisted-settings-state.md`. The
      // blob itself is now abandoned unread — deliberately NOT wiped, so a
      // restart can still recover the holds nobody touched — and anything
      // recorded against it (a tombstoned release and its pending write)
      // stays outstanding until a reconciling read or write settles it; the
      // trailing flush below makes the first attempt.
      else if (stateUnavailable && now() >= persistBlockedUntilMs) {
        stateUnavailable = false;
        blobAbandonedUnreconciled = true;
      }
    }
    flushPendingWrite();
  };

  const releaseDeOptedHolds = (): string[] => {
    settleState();
    return dropDeOptedHolds();
  };

  // An opt-in cleared while the app was down would otherwise leave the reloaded
  // hold honoured forever — there is no other path that reconciles the two.
  releaseDeOptedHolds();

  return {
    isEnabledForDevice,
    isHeld: (deviceId) => {
      settleState();
      if (holdsByDeviceId.has(deviceId)) return true;
      if (!stateUnavailable) return false;
      // An explicit release beats the guess below: the device was observed ON,
      // which is direct evidence no hold applies, however unreadable the store.
      if (releasedWhileUnavailable.has(deviceId)) return false;
      // Persisted state unknown: an opted-in device may have a hold we simply
      // could not read, and answering "not held" is exactly the resume this
      // feature exists to prevent. Bounded by the grace window, and harmless for
      // a running device — every consumer pairs this with "still observed off".
      // When the OPT-IN map is unreadable too, we cannot even tell which devices
      // those are, so every device fails closed (see `mayBeHeldInUnreadBlob`).
      // That window means the settings service is wholly unavailable — normally
      // cleared by the first retry seconds later, and hard-bounded by the grace
      // window.
      return mayBeHeldInUnreadBlob(deviceId);
    },
    startHold: (deviceId) => {
      settleState();
      if (holdsByDeviceId.has(deviceId)) return false;
      return applyMutation(() => {
        holdsByDeviceId.set(deviceId, { sinceMs: now() });
        return true;
      });
    },
    clearHold: (deviceId) => {
      settleState();
      const blobMayStillRecordHolds = stateUnavailable || blobAbandonedUnreconciled;
      if (blobMayStillRecordHolds && !releasedWhileUnavailable.has(deviceId)) {
        releasedWhileUnavailable.add(deviceId);
        // The map misses what the blob may record, so the delete below can land
        // on nothing — and a clear that retains no pending write is dropped on
        // the floor when the read never recovers: a restart then reloads the
        // stale hold and strands a device the user already turned back on. A
        // tombstoned clear of a device the blob could actually hold is
        // therefore itself an unpersisted mutation, pending until a
        // reconciling read-merge or save lands; the flush retries a throwing
        // save on every access, like any other withheld mutation. The opt-in
        // gate keeps the pull sweep — which clears every observed-ON device,
        // opted in or not — from pending that write for devices a RESOLVED
        // opt-in read rules out. That protection is conditional: while the
        // opt-in read is unavailable too (a total settings outage — both keys
        // sit behind the same settings service), no device can be ruled out
        // and every tombstone pends the write; containment then falls to the
        // read-before-save reconcile in `settleState` — a merge when the read
        // heals, the full replace only when it never does.
        if (mayBeHeldInUnreadBlob(deviceId)) unpersistedMutation = true;
      }
      const removed = applyMutation(() => holdsByDeviceId.delete(deviceId));
      // A delete that landed on nothing performed no mutation, so
      // `applyMutation` did not flush — and the `settleState` at the top of
      // this call ran before the tombstone above existed. Settle again so the
      // reconcile this very call created (`reconcileOwed`: un-throttled
      // read-before-save, then flush) runs NOW rather than on the next
      // access: under `power_source = flow` the next access can be far away,
      // and a restart inside that gap would lose a release a healthy write
      // path could have landed immediately. During the grace window this is
      // a designed no-op — the flush stays blocked and the blob protected.
      if (!removed && unpersistedMutation) settleState();
      return removed;
    },
    heldDeviceIds: () => {
      settleState();
      // Reconcile opt-outs here too, not only on the settings-change edge. That
      // edge's read can fail, and nothing else would retry it — the device would
      // stay held until the user changed a setting again or turned it on by hand.
      // This runs once per plan cycle (the pull-path release sweep) and costs
      // nothing at all while no device is held.
      dropDeOptedHolds();
      return Array.from(holdsByDeviceId.keys());
    },
    releaseDeOptedHolds,
  };
};
