import {
  createDeferredObjectiveHoursRemainingBus,
  createDeferredObjectiveHoursRemainingTracker,
  type DeferredObjectiveHoursRemainingEvent,
} from '../lib/objectives/deferredObjectives';
import {
  HOURS_REMAINING_LATCH_VERSION,
  type PersistedHoursRemainingLatch,
} from '../lib/objectives/deferredObjectives/hoursRemainingCrossings';
import type { DeferredObjectiveDiagnostic } from '../lib/objectives/deferredObjectives/diagnosticsBridge';

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
  expectedStepId: null,
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

  describe('persistence across app restart', () => {
    // Simulates the round trip across an app restart. `boot` constructs a fresh
    // tracker wired to a shared in-memory settings store and returns the same
    // helpers as `setup`. Restarting the app == constructing a second tracker
    // against the same store.
    const bootWithSettings = (initial?: unknown) => {
      const store: { value: unknown } = { value: initial };
      const bus = createDeferredObjectiveHoursRemainingBus();
      const events: DeferredObjectiveHoursRemainingEvent[] = [];
      bus.onCrossing((event) => events.push(event));
      const tracker = createDeferredObjectiveHoursRemainingTracker({
        load: () => store.value,
        save: (latch) => { store.value = latch; },
      });
      const observe = (diagnostics: DeferredObjectiveDiagnostic[], nowMs: number): void => {
        tracker.observe({ diagnostics, nowMs, bus });
      };
      return { bus, tracker, events, observe, store };
    };

    it('persists the latch after a crossing fires', () => {
      const { events, observe, store } = bootWithSettings();
      const deadlineAtMs = 100 * HOUR_MS;
      observe([baseDiagnostic({ deviceId: 'ev-1', deadlineAtMs })], deadlineAtMs - 2 * HOUR_MS);
      expect(events).toHaveLength(1);
      // After the crossing fires, the persisted shape carries the latch entry
      // keyed by the device id, with the boundary the trigger just fired at.
      // This is the byte the restart path consumes to suppress the re-fire.
      expect(store.value).toEqual({
        version: HOURS_REMAINING_LATCH_VERSION,
        entriesByDeviceId: {
          'ev-1': { deadlineAtMs, lastEmittedHoursRemaining: 2 },
        },
      } satisfies PersistedHoursRemainingLatch);
    });

    it('does not re-fire on cold-start when the threshold was already crossed pre-restart', () => {
      // Pre-restart: a task crosses the 2h boundary and fires.
      const before = bootWithSettings();
      const deadlineAtMs = 100 * HOUR_MS;
      before.observe([baseDiagnostic({ deviceId: 'ev-1', deadlineAtMs })], deadlineAtMs - 2 * HOUR_MS);
      expect(before.events).toHaveLength(1);
      // Restart: a new tracker constructed against the same persisted latch.
      // Same deadline, now 1h remaining (already below the user's notional 2h
      // threshold). Without persistence, the in-memory `previousHoursRemaining`
      // would be `null` and the boundary 1 would emit a fresh "crossing" — and
      // the run listener treats null-prior as fires-for-any-threshold-it's-now-
      // below, so a 2h-or-fewer flow would re-trigger on boot. With the
      // persisted latch, prior is 2 → 1<2 is a *genuine* downward edge of the
      // 1h boundary, and the 2h flow stays silent.
      const after = bootWithSettings(before.store.value);
      after.observe([baseDiagnostic({ deviceId: 'ev-1', deadlineAtMs })], deadlineAtMs - HOUR_MS);
      expect(after.events).toHaveLength(1);
      expect(after.events[0]).toMatchObject({ hoursRemaining: 1, previousHoursRemaining: 2 });
    });

    it('does not emit on cold-start when remaining stays within the same hour as the last persisted boundary', () => {
      // Pre-restart: latch at boundary 2.
      const before = bootWithSettings();
      const deadlineAtMs = 100 * HOUR_MS;
      before.observe([baseDiagnostic({ deviceId: 'ev-1', deadlineAtMs })], deadlineAtMs - 2 * HOUR_MS);
      expect(before.events).toHaveLength(1);
      // Restart 5 minutes later — still inside the 2h boundary.
      const after = bootWithSettings(before.store.value);
      after.observe([baseDiagnostic({ deviceId: 'ev-1', deadlineAtMs })], deadlineAtMs - 1.95 * HOUR_MS);
      expect(after.events).toHaveLength(0);
    });

    it('fires fresh on cold-start when the deadline was rescheduled to a different time', () => {
      // Pre-restart: latched against deadline A.
      const before = bootWithSettings();
      const deadlineA = 100 * HOUR_MS;
      before.observe([baseDiagnostic({ deviceId: 'ev-1', deadlineAtMs: deadlineA })], deadlineA - 2 * HOUR_MS);
      expect(before.events).toHaveLength(1);
      // Restart against the persisted latch, but the user has rescheduled
      // ready-by — deadlineAtMs differs from the persisted entry. The new
      // deadline is a fresh arm: previous = null, fires once at the first
      // post-restart observation. This is the "re-arms when the ready-by time
      // is rescheduled" half of the Flow card's contract.
      const deadlineB = 200 * HOUR_MS;
      const after = bootWithSettings(before.store.value);
      after.observe([baseDiagnostic({ deviceId: 'ev-1', deadlineAtMs: deadlineB })], deadlineB - 3 * HOUR_MS);
      expect(after.events).toHaveLength(1);
      expect(after.events[0]).toMatchObject({ hoursRemaining: 3, previousHoursRemaining: null });
    });

    it('falls back to first-observation seed when the persisted payload is missing', () => {
      // Cold-start with nothing persisted. Behaves identically to the
      // pre-persistence tracker: first observation arms and emits.
      const { events, observe } = bootWithSettings(undefined);
      const deadlineAtMs = 100 * HOUR_MS;
      observe([baseDiagnostic({ deviceId: 'ev-1', deadlineAtMs })], deadlineAtMs - 1.5 * HOUR_MS);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ hoursRemaining: 2, previousHoursRemaining: null });
    });

    it('falls back to first-observation seed when the persisted payload is corrupt', () => {
      // Wrong shape entirely (a tampered/downgraded payload). Validator returns
      // null, in-memory map starts empty, first observation arms fresh.
      const { events, observe } = bootWithSettings({ totally: 'wrong' });
      const deadlineAtMs = 100 * HOUR_MS;
      observe([baseDiagnostic({ deviceId: 'ev-1', deadlineAtMs })], deadlineAtMs - 1.5 * HOUR_MS);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ hoursRemaining: 2, previousHoursRemaining: null });
    });

    it('falls back to first-observation seed when the persisted version is unknown', () => {
      // A future-version payload from a downgrade — fail closed (drop the
      // setting) rather than mis-interpret a possibly-incompatible shape.
      const { events, observe } = bootWithSettings({
        version: 99,
        entriesByDeviceId: { 'ev-1': { deadlineAtMs: 1, lastEmittedHoursRemaining: 1 } },
      });
      const deadlineAtMs = 100 * HOUR_MS;
      observe([baseDiagnostic({ deviceId: 'ev-1', deadlineAtMs })], deadlineAtMs - 1.5 * HOUR_MS);
      expect(events).toHaveLength(1);
      expect(events[0]!.previousHoursRemaining).toBeNull();
    });

    it('drops corrupt per-device entries but keeps valid ones from the same payload', () => {
      const { events, observe } = bootWithSettings({
        version: HOURS_REMAINING_LATCH_VERSION,
        entriesByDeviceId: {
          'ev-good': { deadlineAtMs: 100 * HOUR_MS, lastEmittedHoursRemaining: 2 },
          'ev-bad': { deadlineAtMs: 'not-a-number', lastEmittedHoursRemaining: 1 },
        },
      });
      const goodDeadline = 100 * HOUR_MS;
      observe([baseDiagnostic({ deviceId: 'ev-good', deadlineAtMs: goodDeadline })], goodDeadline - 1.5 * HOUR_MS);
      // Good entry survived: latch is 2, current ceil is 2 — no crossing.
      expect(events).toHaveLength(0);
      // Bad entry was dropped: next observation against ev-bad arms fresh.
      observe([baseDiagnostic({ deviceId: 'ev-bad', deadlineAtMs: 200 * HOUR_MS })], 200 * HOUR_MS - 0.5 * HOUR_MS);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ deviceId: 'ev-bad', previousHoursRemaining: null });
    });

    it('survives a throwing load callback without crashing and uses an empty in-memory latch', () => {
      // Transient SDK failure on cold-start. Per
      // `feedback_homey_sdk_unreliable`, treat as missing — never delete the
      // persisted state, never crash. The tracker constructs normally with an
      // empty in-memory latch.
      const writes: PersistedHoursRemainingLatch[] = [];
      const bus = createDeferredObjectiveHoursRemainingBus();
      const events: DeferredObjectiveHoursRemainingEvent[] = [];
      bus.onCrossing((event) => events.push(event));
      const tracker = createDeferredObjectiveHoursRemainingTracker({
        load: () => { throw new Error('settings unavailable'); },
        save: (latch) => { writes.push(latch); },
      });
      const deadlineAtMs = 100 * HOUR_MS;
      tracker.observe({
        diagnostics: [baseDiagnostic({ deviceId: 'ev-1', deadlineAtMs })],
        nowMs: deadlineAtMs - 1.5 * HOUR_MS,
        bus,
      });
      expect(events).toHaveLength(1);
      // The subsequent save() still runs so the next restart can read it.
      expect(writes.at(-1)?.entriesByDeviceId['ev-1']).toEqual({
        deadlineAtMs,
        lastEmittedHoursRemaining: 2,
      });
    });

    it('does not write to settings on cycles where the in-memory latch did not change', () => {
      // Persistence write debounce: settings I/O is synchronous on Homey, so a
      // per-cycle write would thrash flash. The tracker only writes when the
      // in-memory map actually changes — a steady-state cycle inside the same
      // hour must be silent.
      const writes: PersistedHoursRemainingLatch[] = [];
      const bus = createDeferredObjectiveHoursRemainingBus();
      const tracker = createDeferredObjectiveHoursRemainingTracker({
        load: () => null,
        save: (latch) => { writes.push(latch); },
      });
      const deadlineAtMs = 100 * HOUR_MS;
      const diag = [baseDiagnostic({ deviceId: 'ev-1', deadlineAtMs })];
      // First observation arms and emits → one write.
      tracker.observe({ diagnostics: diag, nowMs: deadlineAtMs - 2 * HOUR_MS, bus });
      expect(writes).toHaveLength(1);
      // Next two observations still inside the same hour → no new write.
      tracker.observe({ diagnostics: diag, nowMs: deadlineAtMs - 1.9 * HOUR_MS, bus });
      tracker.observe({ diagnostics: diag, nowMs: deadlineAtMs - 1.5 * HOUR_MS, bus });
      expect(writes).toHaveLength(1);
      // Drop below the next boundary → one more write.
      tracker.observe({ diagnostics: diag, nowMs: deadlineAtMs - 0.5 * HOUR_MS, bus });
      expect(writes).toHaveLength(2);
    });
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
