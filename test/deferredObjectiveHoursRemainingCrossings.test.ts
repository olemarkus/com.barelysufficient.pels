import {
  createDeferredObjectiveHoursRemainingBus,
  createDeferredObjectiveHoursRemainingTracker,
  type DeferredObjectiveHoursRemainingEvent,
} from '../lib/plan/deferredObjectives';
import type { DeferredObjectiveDiagnostic } from '../lib/plan/deferredObjectives/diagnosticsBridge';

const HOUR_MS = 60 * 60 * 1000;

const baseDiagnostic = (overrides: Partial<DeferredObjectiveDiagnostic> & {
  deviceId: string;
}): DeferredObjectiveDiagnostic => ({
  deviceName: 'Boiler',
  objectiveId: `${overrides.deviceId}:temperature`,
  objectiveKind: 'temperature',
  enforcement: 'soft',
  status: 'on_track',
  reasonCode: 'objective_progress_stale',
  targetPercent: null,
  currentPercent: null,
  targetTemperatureC: 55,
  currentTemperatureC: 50,
  deadlineAtMs: 0,
  deadlineLocalTime: '07:00',
  energyNeededKWh: 1.5,
  kWhPerPercent: null,
  kWhPerDegreeC: 0.3,
  rateConfidence: null,
  horizonBucketCount: 1,
  dailyBudgetExhaustedBucketCount: 0,
  requestedMinimumStepId: null,
  ...overrides,
});

const setup = () => {
  const bus = createDeferredObjectiveHoursRemainingBus();
  const tracker = createDeferredObjectiveHoursRemainingTracker();
  const events: DeferredObjectiveHoursRemainingEvent[] = [];
  bus.onCrossing((event) => events.push(event));
  const observe = (diagnostics: DeferredObjectiveDiagnostic[], nowMs: number): void => {
    tracker.observe({ diagnostics, nowMs, bus });
  };
  return { bus, tracker, events, observe };
};

describe('deferred-objective hours-remaining crossings', () => {
  it('emits one crossing per integer-hour boundary as remaining drops', () => {
    const { events, observe } = setup();
    const deadlineAtMs = 100 * HOUR_MS;
    const diag = [baseDiagnostic({ deviceId: 'ev-1', deadlineAtMs })];

    // First observation 3.5h out arms at boundary 4 and emits it (no prior).
    observe(diag, deadlineAtMs - 3.5 * HOUR_MS);
    // Still inside the 4h boundary: ceil(3.1) = 4 — no new crossing.
    observe(diag, deadlineAtMs - 3.1 * HOUR_MS);
    // Drops below 3h: ceil(2.9) = 3 — crossing to 3.
    observe(diag, deadlineAtMs - 2.9 * HOUR_MS);
    // Exactly 2h remaining: ceil(2.0) = 2 — crossing to 2.
    observe(diag, deadlineAtMs - 2 * HOUR_MS);

    expect(events.map((e) => e.hoursRemaining)).toEqual([4, 3, 2]);
    expect(events.map((e) => e.previousHoursRemaining)).toEqual([null, 4, 3]);
    expect(events.every((e) => e.deviceId === 'ev-1')).toBe(true);
  });

  it('does not re-fire on subsequent cycles while remaining stays within the same hour', () => {
    const { events, observe } = setup();
    const deadlineAtMs = 100 * HOUR_MS;
    const diag = [baseDiagnostic({ deviceId: 'ev-1', deadlineAtMs })];

    observe(diag, deadlineAtMs - 2 * HOUR_MS); // ceil 2 -> emit
    observe(diag, deadlineAtMs - 1.9 * HOUR_MS); // ceil 2 -> no emit
    observe(diag, deadlineAtMs - 1.5 * HOUR_MS); // ceil 2 -> no emit
    expect(events).toHaveLength(1);
    expect(events[0]!.hoursRemaining).toBe(2);
  });

  it('does not emit on an upward boundary move (e.g. clock skew) but keeps the latch fresh', () => {
    const { events, observe } = setup();
    const deadlineAtMs = 100 * HOUR_MS;
    const diag = [baseDiagnostic({ deviceId: 'ev-1', deadlineAtMs })];

    observe(diag, deadlineAtMs - 2 * HOUR_MS); // ceil 2 -> emit (first)
    observe(diag, deadlineAtMs - 3 * HOUR_MS); // ceil 3 -> upward, no emit
    expect(events).toHaveLength(1);
    // Dropping back below 2h should emit again from the refreshed (3) latch.
    observe(diag, deadlineAtMs - HOUR_MS); // ceil 1 -> emit
    expect(events.map((e) => e.hoursRemaining)).toEqual([2, 1]);
  });

  it('fires once for a task created already under the threshold', () => {
    const { events, observe } = setup();
    const deadlineAtMs = 100 * HOUR_MS;
    const diag = [baseDiagnostic({ deviceId: 'ev-1', deadlineAtMs })];

    // First-ever observation at 0.5h remaining: ceil 1, prior is null.
    observe(diag, deadlineAtMs - 0.5 * HOUR_MS);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ hoursRemaining: 1, previousHoursRemaining: null });
    // Next cycle still within the 1h boundary: no re-fire.
    observe(diag, deadlineAtMs - 0.4 * HOUR_MS);
    expect(events).toHaveLength(1);
  });

  it('re-arms when the deadline changes (reschedule) and treats it as a fresh crossing', () => {
    const { events, observe } = setup();
    const firstDeadline = 100 * HOUR_MS;
    observe([baseDiagnostic({ deviceId: 'ev-1', deadlineAtMs: firstDeadline })], firstDeadline - 2 * HOUR_MS);
    expect(events.map((e) => e.hoursRemaining)).toEqual([2]);

    // Rescheduled further out — same device, different deadline. The first
    // observation against the new deadline arms fresh (previous = null).
    const secondDeadline = 200 * HOUR_MS;
    observe([baseDiagnostic({ deviceId: 'ev-1', deadlineAtMs: secondDeadline })], secondDeadline - 3 * HOUR_MS);
    expect(events).toHaveLength(2);
    expect(events[1]).toMatchObject({ hoursRemaining: 3, previousHoursRemaining: null });
  });

  it('does not emit a crossing once the deadline has passed (lead-time trigger only)', () => {
    const { events, observe } = setup();
    const deadlineAtMs = 100 * HOUR_MS;
    // First-ever observation already past the deadline (e.g. a stale enabled
    // objective seen on the first plan cycle after a restart). The missed/ended
    // surface owns post-deadline events; this lead-time trigger stays silent.
    observe([baseDiagnostic({ deviceId: 'ev-1', deadlineAtMs })], deadlineAtMs + 5 * HOUR_MS);
    expect(events).toHaveLength(0);
  });

  it('does not fire at 0h as a normal countdown reaches the deadline', () => {
    const { events, observe } = setup();
    const deadlineAtMs = 100 * HOUR_MS;
    const diag = [baseDiagnostic({ deviceId: 'ev-1', deadlineAtMs })];
    observe(diag, deadlineAtMs - 1.5 * HOUR_MS); // ceil 2 -> emit
    observe(diag, deadlineAtMs - 0.5 * HOUR_MS); // ceil 1 -> emit
    observe(diag, deadlineAtMs); // reached: suppressed
    observe(diag, deadlineAtMs + HOUR_MS); // passed: suppressed
    expect(events.map((e) => e.hoursRemaining)).toEqual([2, 1]);
  });

  it('skips diagnostics without a usable deadline and re-arms cleanly afterwards', () => {
    const { events, observe } = setup();
    const deadlineAtMs = 100 * HOUR_MS;
    // No deadline yet (waiting for a horizon): nothing emitted, no latch.
    observe([baseDiagnostic({ deviceId: 'ev-1', deadlineAtMs: null })], deadlineAtMs - 2 * HOUR_MS);
    expect(events).toHaveLength(0);
    // Deadline appears: first observation arms and emits.
    observe([baseDiagnostic({ deviceId: 'ev-1', deadlineAtMs })], deadlineAtMs - 2 * HOUR_MS);
    expect(events.map((e) => e.hoursRemaining)).toEqual([2]);
    expect(events[0]!.previousHoursRemaining).toBeNull();
  });

  it('forgetDevice drops the latch so a re-added task re-arms', () => {
    const { tracker, bus, events, observe } = setup();
    const deadlineAtMs = 100 * HOUR_MS;
    const diag = [baseDiagnostic({ deviceId: 'ev-1', deadlineAtMs })];
    observe(diag, deadlineAtMs - 2 * HOUR_MS); // emit at 2
    tracker.forgetDevice('ev-1');
    // Same deadline, still 2h out: without re-arm this would be silent; after
    // forget it emits fresh.
    tracker.observe({ diagnostics: diag, nowMs: deadlineAtMs - 2 * HOUR_MS, bus });
    expect(events).toHaveLength(2);
    expect(events[1]).toMatchObject({ hoursRemaining: 2, previousHoursRemaining: null });
  });

  it('drops latches for devices that disappear from the diagnostics list', () => {
    const { events, observe } = setup();
    const deadlineAtMs = 100 * HOUR_MS;
    observe([baseDiagnostic({ deviceId: 'ev-1', deadlineAtMs })], deadlineAtMs - 2 * HOUR_MS); // emit at 2
    // Device gone this cycle — latch dropped via the sweep.
    observe([], deadlineAtMs - 1.5 * HOUR_MS);
    // Device returns, same deadline, still 1.5h out (ceil 2): re-arms fresh.
    observe([baseDiagnostic({ deviceId: 'ev-1', deadlineAtMs })], deadlineAtMs - 1.5 * HOUR_MS);
    expect(events).toHaveLength(2);
    expect(events[1]).toMatchObject({ hoursRemaining: 2, previousHoursRemaining: null });
  });

  it('falls back to null device name and stops delivering after unsubscribe', () => {
    const bus = createDeferredObjectiveHoursRemainingBus();
    const tracker = createDeferredObjectiveHoursRemainingTracker();
    const events: DeferredObjectiveHoursRemainingEvent[] = [];
    const unsubscribe = bus.onCrossing((event) => events.push(event));
    const deadlineAtMs = 100 * HOUR_MS;
    // deviceName omitted on the diagnostic -> event carries null.
    const diag = [baseDiagnostic({ deviceId: 'ev-1', deadlineAtMs, deviceName: undefined })];
    tracker.observe({ diagnostics: diag, nowMs: deadlineAtMs - 2 * HOUR_MS, bus });
    expect(events).toHaveLength(1);
    expect(events[0]!.deviceName).toBeNull();

    unsubscribe();
    tracker.forgetDevice('ev-1');
    tracker.observe({ diagnostics: diag, nowMs: deadlineAtMs - 2 * HOUR_MS, bus });
    expect(events).toHaveLength(1); // listener removed; no further delivery
  });

  it('computes remaining hours from real elapsed ms (DST-safe), not a local hour index', () => {
    // The deadline persists as an absolute timestamp (`deadlineAtMs`) and the
    // tracker subtracts `nowMs` from it directly. This is the DST-safety
    // property: across a spring-forward day (e.g. Europe/Oslo 2026-03-29, when
    // 02:00->03:00 is skipped and the day is only 23 hours long) a "04:00
    // local" deadline still resolves to a single instant, and the remaining
    // time is the true wall-clock gap to that instant — never derived from a
    // local hour-of-day count that would miscount the skipped hour.
    //
    // Both inputs below are absolute UTC instants 90 minutes apart, so the
    // real remaining time is 1.5h regardless of any zone offset, and ceil(1.5)
    // must be 2. A buggy implementation that bucketed by local hour index
    // could land on a different boundary; this asserts we don't.
    const { events, observe } = setup();
    const deadlineAtMs = Date.UTC(2026, 2, 29, 2, 0, 0);
    const nowMs = deadlineAtMs - 90 * 60 * 1000;
    expect((deadlineAtMs - nowMs) / HOUR_MS).toBeCloseTo(1.5, 9);
    observe([baseDiagnostic({ deviceId: 'ev-1', deadlineAtMs })], nowMs);
    expect(events).toHaveLength(1);
    expect(events[0]!.hoursRemaining).toBe(2);
  });
});
