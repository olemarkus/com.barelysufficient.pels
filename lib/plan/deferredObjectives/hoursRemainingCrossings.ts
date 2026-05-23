import type { DeferredObjectiveDiagnostic } from './diagnosticsBridge';
import type {
  DeferredObjectiveHoursRemainingBus,
  DeferredObjectiveHoursRemainingEvent,
} from './hoursRemainingBus';

const HOUR_MS = 60 * 60 * 1000;

// Per-device latch so the crossing is published once per integer-hour boundary
// instead of every plan cycle. Keyed by deviceId; carries the deadline it was
// armed against so a changed/cleared deadline re-arms (treats the next
// observation as a fresh crossing rather than continuing a stale comparison).
type CrossingLatchEntry = {
  deadlineAtMs: number;
  lastEmittedHoursRemaining: number;
};

// Persisted shape — restored by `load` on construction so an app restart while
// an existing deadline is already below the user's threshold doesn't re-fire
// the trigger on the first observation after boot. `load` returns `null` for
// an absent / corrupt / never-written setting; the tracker treats that the
// same as a cold-start with no latch (existing behaviour pre-persistence) so a
// single transient settings read failure cannot wipe the latch permanently.
// Per `feedback_homey_sdk_unreliable`.
export type PersistedHoursRemainingLatch = {
  // Bumped when the persisted shape changes. The validator rejects anything
  // else so a tampered / downgraded payload is treated as missing rather than
  // smuggled past type checks.
  version: 1;
  entriesByDeviceId: Record<string, CrossingLatchEntry>;
};

export const HOURS_REMAINING_LATCH_VERSION = 1 as const;

export type DeferredObjectiveHoursRemainingTracker = {
  observe: (params: {
    diagnostics: DeferredObjectiveDiagnostic[];
    nowMs: number;
    bus: DeferredObjectiveHoursRemainingBus;
  }) => void;
  forgetDevice: (deviceId: string) => void;
};

// Persistence dependencies. Both are optional so the tracker stays usable in
// pure-unit tests (no settings backend) and from constructors that haven't
// wired settings yet. `load` is called once at construction; `save` is called
// every time the in-memory latch changes (a crossing fires, a stale entry is
// swept, or `forgetDevice` runs) so the persisted shape stays in sync with the
// authoritative in-memory map. `save` is *not* called per cycle when nothing
// changed — see `applyMutation` below.
export type DeferredObjectiveHoursRemainingTrackerDeps = {
  load?: () => unknown;
  save?: (latch: PersistedHoursRemainingLatch) => void;
};

// Whole hours remaining until the deadline, rounded UP so the boundary fires at
// the moment the task drops to/below that hour mark (e.g. remaining = 2.0h
// yields 2, remaining = 1.99h yields 2, remaining = 1.0h yields 1). Only called
// for a strictly-future deadline (`observeDiagnostic` guards passed deadlines),
// so the result is always >= 1.
const computeHoursRemaining = (deadlineAtMs: number, nowMs: number): number => (
  Math.ceil((deadlineAtMs - nowMs) / HOUR_MS)
);

const isCrossingLatchEntry = (value: unknown): value is CrossingLatchEntry => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  return typeof v.deadlineAtMs === 'number'
    && Number.isFinite(v.deadlineAtMs)
    && v.deadlineAtMs > 0
    && typeof v.lastEmittedHoursRemaining === 'number'
    && Number.isFinite(v.lastEmittedHoursRemaining)
    && v.lastEmittedHoursRemaining >= 0;
};

// Validates the persisted payload against the v1 shape. Rejects everything
// else (missing, wrong version, corrupt entries) so a single bad read cannot
// pollute the in-memory map with garbage — the caller treats `null` as "no
// persisted state" and falls back to first-observation seeding.
const parsePersistedLatch = (raw: unknown): PersistedHoursRemainingLatch | null => {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const candidate = raw as Partial<PersistedHoursRemainingLatch>;
  if (candidate.version !== HOURS_REMAINING_LATCH_VERSION) return null;
  if (!candidate.entriesByDeviceId
    || typeof candidate.entriesByDeviceId !== 'object'
    || Array.isArray(candidate.entriesByDeviceId)) {
    return null;
  }
  const entries: [string, CrossingLatchEntry][] = [];
  for (const [deviceId, entry] of Object.entries(candidate.entriesByDeviceId)) {
    if (typeof deviceId !== 'string' || deviceId.length === 0) continue;
    if (!isCrossingLatchEntry(entry)) continue;
    entries.push([deviceId, entry]);
  }
  return {
    version: HOURS_REMAINING_LATCH_VERSION,
    entriesByDeviceId: Object.fromEntries(entries),
  };
};

const serializeLatch = (latch: Map<string, CrossingLatchEntry>): PersistedHoursRemainingLatch => ({
  version: HOURS_REMAINING_LATCH_VERSION,
  entriesByDeviceId: Object.fromEntries(latch.entries()),
});

const loadPersistedLatch = (
  deps: DeferredObjectiveHoursRemainingTrackerDeps,
): Map<string, CrossingLatchEntry> => {
  const latch = new Map<string, CrossingLatchEntry>();
  if (!deps.load) return latch;
  // A throwing/missing read on cold-start is treated the same as "no persisted
  // state" — the tracker falls back to first-observation seeding, which is the
  // pre-persistence behaviour. Never crash startup; never wipe persisted state
  // (the caller's `save` is the only path that ever overwrites the setting).
  let raw: unknown;
  try {
    raw = deps.load();
  } catch {
    return latch;
  }
  const parsed = parsePersistedLatch(raw);
  if (!parsed) return latch;
  for (const [deviceId, entry] of Object.entries(parsed.entriesByDeviceId)) {
    latch.set(deviceId, entry);
  }
  return latch;
};

export const createDeferredObjectiveHoursRemainingTracker = (
  deps: DeferredObjectiveHoursRemainingTrackerDeps = {},
): DeferredObjectiveHoursRemainingTracker => {
  const latchByDeviceId = loadPersistedLatch(deps);

  // Persist whenever the in-memory map actually changed. Skipping no-op cycles
  // matters: `observe` runs every plan cycle, but the latch only changes on a
  // genuine downward crossing (a publish), a deadline-change reset, an upward
  // refresh, a passed-deadline floor, or a sweep. Settings writes are
  // synchronous on Homey; per-cycle writes would thrash flash.
  const applyMutation = (mutate: () => boolean): void => {
    const changed = mutate();
    if (!changed) return;
    if (!deps.save) return;
    try {
      deps.save(serializeLatch(latchByDeviceId));
    } catch {
      // Persistence failure leaves the in-memory latch authoritative. Next
      // mutation retries the write; a permanent failure degrades to in-memory
      // only (the pre-persistence behaviour), which is strictly better than
      // crashing the plan cycle.
    }
  };

  const forgetDevice = (deviceId: string): void => {
    applyMutation(() => latchByDeviceId.delete(deviceId));
  };

  const observe = (params: {
    diagnostics: DeferredObjectiveDiagnostic[];
    nowMs: number;
    bus: DeferredObjectiveHoursRemainingBus;
  }): void => {
    const { diagnostics, nowMs, bus } = params;
    applyMutation(() => {
      let changed = false;
      const seen = new Set<string>();
      for (const diagnostic of diagnostics) {
        const result = observeDiagnostic({ diagnostic, nowMs, latchByDeviceId });
        seen.add(diagnostic.deviceId);
        if (result.latchChanged) changed = true;
        if (result.event) bus.publish(result.event);
      }
      // Drop latches for devices that no longer have an active diagnostic so a
      // later re-added task starts from a clean arm. Collect first, then delete —
      // mutating the Map while iterating its key view is unsafe.
      const staleDeviceIds = Array.from(latchByDeviceId.keys()).filter((id) => !seen.has(id));
      for (const staleId of staleDeviceIds) {
        latchByDeviceId.delete(staleId);
        changed = true;
      }
      return changed;
    });
  };

  return { observe, forgetDevice };
};

type ObserveDiagnosticResult = {
  event: DeferredObjectiveHoursRemainingEvent | null;
  // `true` whenever the in-memory latch entry for this device was inserted,
  // updated, or deleted in a way that the persisted shape would differ from
  // the previous serialized snapshot. Drives the per-cycle dirty-bit used to
  // decide whether to write to settings.
  latchChanged: boolean;
};

const observeDiagnostic = (params: {
  diagnostic: DeferredObjectiveDiagnostic;
  nowMs: number;
  latchByDeviceId: Map<string, CrossingLatchEntry>;
}): ObserveDiagnosticResult => {
  const { diagnostic, nowMs, latchByDeviceId } = params;
  const { deviceId, deadlineAtMs } = diagnostic;
  if (deadlineAtMs === null || !Number.isFinite(deadlineAtMs)) {
    // No usable deadline — drop any stale latch so the device re-arms cleanly
    // once a deadline reappears.
    const had = latchByDeviceId.delete(deviceId);
    return { event: null, latchChanged: had };
  }

  if (deadlineAtMs <= nowMs) {
    // Deadline already reached/passed. This is a *lead-time* trigger ("act N
    // hours before the deadline"); a passed deadline is the missed/ended
    // surface's job, not ours. Refresh the latch to the floor (0) so a later
    // reschedule to a future time re-arms against a clean baseline, but never
    // emit a 0-hours "crossing" — e.g. on the first plan cycle after a restart
    // with a stale-but-still-enabled past-deadline objective.
    const prior = latchByDeviceId.get(deviceId);
    const next: CrossingLatchEntry = { deadlineAtMs, lastEmittedHoursRemaining: 0 };
    const changed = !prior
      || prior.deadlineAtMs !== next.deadlineAtMs
      || prior.lastEmittedHoursRemaining !== next.lastEmittedHoursRemaining;
    latchByDeviceId.set(deviceId, next);
    return { event: null, latchChanged: changed };
  }

  const hoursRemaining = computeHoursRemaining(deadlineAtMs, nowMs);
  const latch = latchByDeviceId.get(deviceId);
  // Re-arm when the deadline changed (reschedule) or was never armed. A
  // persisted entry from a prior boot survives this check unchanged when the
  // deadline still matches: the in-memory `latch` carries the previously
  // emitted boundary, so the first post-restart observation sees the same
  // `previousHoursRemaining` it would have seen pre-restart and suppresses the
  // re-fire.
  const armedForSameDeadline = latch?.deadlineAtMs === deadlineAtMs;
  const previousHoursRemaining = armedForSameDeadline ? latch!.lastEmittedHoursRemaining : null;

  // Only the *downward* edge across an integer-hour boundary is a crossing.
  // First observation (no prior for this deadline) counts as a crossing so a
  // task created already under a threshold still fires once.
  const isDownwardCrossing = previousHoursRemaining === null || hoursRemaining < previousHoursRemaining;
  if (!isDownwardCrossing) {
    // Same or increased boundary: refresh the latch (so a later decrease has an
    // accurate comparison point) without emitting.
    const next: CrossingLatchEntry = { deadlineAtMs, lastEmittedHoursRemaining: hoursRemaining };
    const changed = !latch
      || latch.deadlineAtMs !== next.deadlineAtMs
      || latch.lastEmittedHoursRemaining !== next.lastEmittedHoursRemaining;
    latchByDeviceId.set(deviceId, next);
    return { event: null, latchChanged: changed };
  }

  latchByDeviceId.set(deviceId, { deadlineAtMs, lastEmittedHoursRemaining: hoursRemaining });
  return {
    event: {
      deviceId,
      deviceName: diagnostic.deviceName ?? null,
      hoursRemaining,
      previousHoursRemaining,
    },
    latchChanged: true,
  };
};
