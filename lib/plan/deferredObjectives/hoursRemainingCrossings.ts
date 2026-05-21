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

export type DeferredObjectiveHoursRemainingTracker = {
  observe: (params: {
    diagnostics: DeferredObjectiveDiagnostic[];
    nowMs: number;
    bus: DeferredObjectiveHoursRemainingBus;
  }) => void;
  forgetDevice: (deviceId: string) => void;
};

// Whole hours remaining until the deadline, rounded UP so the boundary fires at
// the moment the task drops to/below that hour mark (e.g. remaining = 2.0h
// yields 2, remaining = 1.99h yields 2, remaining = 1.0h yields 1). Only called
// for a strictly-future deadline (`observeDiagnostic` guards passed deadlines),
// so the result is always >= 1.
const computeHoursRemaining = (deadlineAtMs: number, nowMs: number): number => (
  Math.ceil((deadlineAtMs - nowMs) / HOUR_MS)
);

export const createDeferredObjectiveHoursRemainingTracker = (): DeferredObjectiveHoursRemainingTracker => {
  const latchByDeviceId = new Map<string, CrossingLatchEntry>();

  const forgetDevice = (deviceId: string): void => {
    latchByDeviceId.delete(deviceId);
  };

  const observe = (params: {
    diagnostics: DeferredObjectiveDiagnostic[];
    nowMs: number;
    bus: DeferredObjectiveHoursRemainingBus;
  }): void => {
    const { diagnostics, nowMs, bus } = params;
    const seen = new Set<string>();
    for (const diagnostic of diagnostics) {
      const event = observeDiagnostic({ diagnostic, nowMs, latchByDeviceId });
      seen.add(diagnostic.deviceId);
      if (event) bus.publish(event);
    }
    // Drop latches for devices that no longer have an active diagnostic so a
    // later re-added task starts from a clean arm. Collect first, then delete —
    // mutating the Map while iterating its key view is unsafe.
    const staleDeviceIds = Array.from(latchByDeviceId.keys()).filter((id) => !seen.has(id));
    for (const staleId of staleDeviceIds) latchByDeviceId.delete(staleId);
  };

  return { observe, forgetDevice };
};

const observeDiagnostic = (params: {
  diagnostic: DeferredObjectiveDiagnostic;
  nowMs: number;
  latchByDeviceId: Map<string, CrossingLatchEntry>;
}): DeferredObjectiveHoursRemainingEvent | null => {
  const { diagnostic, nowMs, latchByDeviceId } = params;
  const { deviceId, deadlineAtMs } = diagnostic;
  if (deadlineAtMs === null || !Number.isFinite(deadlineAtMs)) {
    // No usable deadline — drop any stale latch so the device re-arms cleanly
    // once a deadline reappears.
    latchByDeviceId.delete(deviceId);
    return null;
  }

  if (deadlineAtMs <= nowMs) {
    // Deadline already reached/passed. This is a *lead-time* trigger ("act N
    // hours before the deadline"); a passed deadline is the missed/ended
    // surface's job, not ours. Refresh the latch to the floor (0) so a later
    // reschedule to a future time re-arms against a clean baseline, but never
    // emit a 0-hours "crossing" — e.g. on the first plan cycle after a restart
    // with a stale-but-still-enabled past-deadline objective.
    latchByDeviceId.set(deviceId, { deadlineAtMs, lastEmittedHoursRemaining: 0 });
    return null;
  }

  const hoursRemaining = computeHoursRemaining(deadlineAtMs, nowMs);
  const latch = latchByDeviceId.get(deviceId);
  // Re-arm when the deadline changed (reschedule) or was never armed.
  const armedForSameDeadline = latch?.deadlineAtMs === deadlineAtMs;
  const previousHoursRemaining = armedForSameDeadline ? latch!.lastEmittedHoursRemaining : null;

  // Only the *downward* edge across an integer-hour boundary is a crossing.
  // First observation (no prior for this deadline) counts as a crossing so a
  // task created already under a threshold still fires once.
  const isDownwardCrossing = previousHoursRemaining === null || hoursRemaining < previousHoursRemaining;
  if (!isDownwardCrossing) {
    // Same or increased boundary: refresh the latch (so a later decrease has an
    // accurate comparison point) without emitting.
    latchByDeviceId.set(deviceId, { deadlineAtMs, lastEmittedHoursRemaining: hoursRemaining });
    return null;
  }

  latchByDeviceId.set(deviceId, { deadlineAtMs, lastEmittedHoursRemaining: hoursRemaining });
  return {
    deviceId,
    deviceName: diagnostic.deviceName ?? null,
    hoursRemaining,
    previousHoursRemaining,
  };
};
