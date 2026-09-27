import { recordPowerSample, type PowerTrackerState } from '../../lib/power/tracker';
import { resolveDisplayedPowerUpdateMs, resolveMeterEvidenceAtMs } from '../../lib/power/lastTotalPower';
import {
  HELD_READING_FREEZE_MS,
  HELD_READING_LONG_HOLD_MEMORY_MS,
  HELD_READING_LONG_HOLD_MS,
  HELD_READING_SETTLE_MS,
  HELD_READING_SUSPECT_MS,
  resolveManagedLoadKey,
  withHeldReadingAfterRestart,
} from '../../lib/power/heldReading';
import { MAX_POWER_SAMPLE_GAP_MS } from '../../lib/power/trackerTypes';
import { captureLogger, type LoggerCapture } from '../utils/loggerCapture';

const T0 = Date.UTC(2026, 8, 14, 12, 0, 0);
const POLL_MS = 10_000;
const SETTLE_POLLS = HELD_READING_SETTLE_MS / POLL_MS;
const SUSPECT_POLLS = HELD_READING_SUSPECT_MS / POLL_MS;
const FREEZE_POLLS = HELD_READING_FREEZE_MS / POLL_MS;
const LONG_HOLD_POLLS = HELD_READING_LONG_HOLD_MS / POLL_MS;
/** The metered loads every sample below sums, unless a spec says otherwise. */
const LOADS = resolveManagedLoadKey(['water-heater', 'car-socket']);
/** No metered loads: a cold snapshot after boot, or a home with a battery. */
const NO_LOADS = resolveManagedLoadKey([]);

/** Record one sample onto `state` and return what the tracker saved. */
const sample = async (
  state: PowerTrackerState,
  currentPowerW: number,
  nowMs: number,
  managedDrawW = 0,
  loadKey = LOADS,
): Promise<PowerTrackerState> => {
  const saveState = vi.fn();
  await recordPowerSample({
    generationSegments: [],
    timeZone: 'UTC',
    state,
    currentPowerW,
    managedDraw: { totalW: managedDrawW, loadKey },
    nowMs,
    rebuildPlanFromCache: vi.fn().mockResolvedValue(undefined),
    saveState,
  });
  return saveState.mock.calls[0][0] as PowerTrackerState;
};

/** Poll `count` more samples of `powerW`, the metered loads drawing `managedDrawW`. */
const hold = async (
  from: PowerTrackerState,
  powerW: number,
  count: number,
  managedDrawW = 0,
  loadKey = LOADS,
): Promise<PowerTrackerState> => {
  let state = from;
  for (let poll = 0; poll < count; poll += 1) {
    state = await sample(state, powerW, (state.lastTimestamp ?? T0) + POLL_MS, managedDrawW, loadKey);
  }
  return state;
};

const nextPollMs = (state: PowerTrackerState): number => (state.lastTimestamp ?? T0) + POLL_MS;

/** A reading that took `powerW` at T0 and has held through the settle window, nothing drawing. */
const settledHold = async (powerW: number): Promise<PowerTrackerState> => (
  hold(await sample({}, powerW, T0), powerW, SETTLE_POLLS)
);

const expectLive = (state: PowerTrackerState): void => {
  expect(resolveDisplayedPowerUpdateMs(state)).toBe(state.lastTimestamp);
  expect(resolveMeterEvidenceAtMs(state)).toBe(state.lastTimestamp);
};

describe('a whole-home reading that stops changing', () => {
  let capture: LoggerCapture;
  beforeEach(() => { capture = captureLogger('info'); });
  afterEach(() => { capture.restore(); });

  it('stays evidence the meter is alive while nothing measured contradicts it', async () => {
    // A threshold-reporting meter at a steady night load, or an idle meter
    // area: one value for an hour is a quiet home, not a dead meter.
    expectLive(await hold(await sample({}, 1100, T0), 1100, 360));
  });

  it('warns after two minutes of contradiction and counts the meter silent after ten', async () => {
    let state = await settledHold(1100);
    // A 3 kW heater comes on; the reading stays on exactly 1100 W.
    state = await hold(state, 1100, 1, 3000);
    expectLive(state);
    state = await hold(state, 1100, SUSPECT_POLLS, 3000);
    // Suspect: the owner is shown the reading as dating from when it took its value.
    expect(resolveDisplayedPowerUpdateMs(state)).toBe(T0);
    expect(resolveMeterEvidenceAtMs(state)).toBe(state.lastTimestamp);
    state = await hold(state, 1100, FREEZE_POLLS - SUSPECT_POLLS, 3000);
    // Frozen: control counts the meter silent since then too.
    expect(resolveMeterEvidenceAtMs(state)).toBe(T0);
    expect(capture.findEvents('whole_home_reading_verdict_changed').map((event) => event.to))
      .toEqual(['suspected', 'frozen']);
    expect(capture.findEvent('whole_home_reading_verdict_changed')).toMatchObject({
      powerW: 1100, heldSinceMs: T0, baselineDrawW: 0, measuredDrawW: 3000,
    });
  });

  it('lets a device report that trails the meter settle into the baseline', async () => {
    let state = await settledHold(1100);
    // A car starts. The meter steps first; the charger's cloud app reports
    // three minutes later. The meter then sits under its reporting threshold.
    state = await sample(state, 8100, nextPollMs(state), 0);
    state = await hold(state, 8100, 18, 0);
    state = await hold(state, 8100, 90, 7000);
    expectLive(state);
  });

  it('clears the suspicion when the load comes back before the reading freezes', async () => {
    let state = await settledHold(1100);
    state = await hold(state, 1100, SUSPECT_POLLS + 6, 3000);
    expect(resolveDisplayedPowerUpdateMs(state)).toBe(T0);
    // The heater's own thermostat switches it off again.
    state = await hold(state, 1100, 1, 0);
    expectLive(state);
    expectLive(await hold(state, 1100, FREEZE_POLLS, 0));
    expect(capture.findEvents('whole_home_reading_verdict_changed').map((event) => event.to))
      .toEqual(['suspected', 'unsuspected']);
  });

  it('never warns on a one-sample spike', async () => {
    let state = await settledHold(1100);
    state = await hold(state, 1100, 1, 3000);
    expectLive(await hold(state, 1100, 2 * FREEZE_POLLS, 0));
  });

  it('stays frozen once frozen, though the fail-closed pass takes the load away', async () => {
    let state = await hold(await settledHold(1100), 1100, FREEZE_POLLS + 1, 3000);
    expect(resolveMeterEvidenceAtMs(state)).toBe(T0);
    // The pass switches the heater off; the dead reading does not follow it.
    state = await hold(state, 1100, 30, 0);
    expect(resolveMeterEvidenceAtMs(state)).toBe(T0);
  });

  it('needs a quarter of the reading, not only a kilowatt, on a home drawing more', async () => {
    // 2 kW on a 12 kW reading is below a meter's relative report threshold.
    expectLive(await hold(await settledHold(12_000), 12_000, 2 * FREEZE_POLLS, 2000));
  });

  it('does not read loads joining the sum as load moving: the snapshot loading after a restart', async () => {
    // The first samples after boot see no loads yet; then the snapshot lands
    // with 6.45 kW of loads already running, while a slow meter holds.
    let state = await hold(await sample({}, 6450, T0, 0, NO_LOADS), 6450, SETTLE_POLLS + 5, 0, NO_LOADS);
    state = await hold(state, 6450, FREEZE_POLLS, 6450);
    expectLive(state);
    // Over the same loads, a move still counts.
    state = await hold(state, 6450, FREEZE_POLLS + 1, 3000);
    expect(resolveMeterEvidenceAtMs(state)).toBe(T0);
  });

  it('carries a frozen verdict across a restart, but earns a suspicion again', async () => {
    const frozen = await hold(await settledHold(1100), 1100, FREEZE_POLLS + 1, 3000);
    const suspect = await hold(await settledHold(1100), 1100, SUSPECT_POLLS + 1, 3000);
    // Back from a restart a minute later with the device read already in: the
    // same loads, still drawing the moved 3 kW. The downtime was never observed.
    const afterRestart = async (state: PowerTrackerState): Promise<PowerTrackerState> => (
      sample(withHeldReadingAfterRestart(state), 1100, (state.lastTimestamp ?? T0) + 60_000, 3000)
    );
    expect(resolveMeterEvidenceAtMs(await afterRestart(frozen))).toBe(T0);
    const resumed = await afterRestart(suspect);
    expectLive(resumed);
    expect(resolveDisplayedPowerUpdateMs(await hold(resumed, 1100, SUSPECT_POLLS, 3000))).toBe(T0);
  });

  it('does not judge, for a day, a meter seen holding one value clean for twenty minutes', async () => {
    // A threshold-reporting meter: 1100 W for over twenty minutes with nothing
    // moving, then a new value. Its holds say nothing about whether it is alive.
    let state = await hold(await sample({}, 1100, T0), 1100, LONG_HOLD_POLLS + 6);
    state = await hold(await sample(state, 3000, nextPollMs(state), 0), 3000, SETTLE_POLLS, 0);
    // A move under its reporting threshold, but past the rule's: it holds on.
    expectLive(await hold(state, 3000, 2 * FREEZE_POLLS, 2500));
  });

  it('judges such a meter again once a day has passed since its long hold', async () => {
    const atMs = T0 + 60 * 60 * 1000;
    const heldSince = (longHoldEndedAtMs: number): PowerTrackerState => ({
      lastPowerW: 3000,
      lastTimestamp: atMs,
      heldReading: {
        powerW: 3000,
        sinceMs: atMs - HELD_READING_SETTLE_MS,
        atMs,
        baseline: { totalW: 0, loadKey: LOADS },
        contradictedAtMs: null,
        longHoldEndedAtMs,
      },
    });
    const exempt = await hold(heldSince(atMs - HELD_READING_LONG_HOLD_MEMORY_MS + 3_600_000), 3000, 2 * SUSPECT_POLLS, 2500);
    expectLive(exempt);
    const judged = await hold(heldSince(atMs - HELD_READING_LONG_HOLD_MEMORY_MS), 3000, 2 * SUSPECT_POLLS, 2500);
    expect(resolveDisplayedPowerUpdateMs(judged)).toBe(atMs - HELD_READING_SETTLE_MS);
  });

  it('does not count a hold that ended suspect as a meter holding of its own accord', async () => {
    let state = await settledHold(1100);
    state = await hold(state, 1100, LONG_HOLD_POLLS - SETTLE_POLLS - 6, 0);
    state = await hold(state, 1100, SUSPECT_POLLS + 6, 3000);
    const heldFromMs = nextPollMs(state);
    state = await hold(await sample(state, 4130, heldFromMs, 3000), 4130, SETTLE_POLLS, 3000);
    state = await hold(state, 4130, SUSPECT_POLLS + 1, 0);
    expect(resolveDisplayedPowerUpdateMs(state)).toBe(heldFromMs);
  });

  it('never holds at 0 W: a feed that cannot express export reads 0 while exporting', async () => {
    expectLive(await hold(await settledHold(0), 0, 2 * FREEZE_POLLS, 3000));
  });

  it('is evidence again, and leaves the frozen stretch unreliable, once the reading moves', async () => {
    let state = await hold(await settledHold(1100), 1100, FREEZE_POLLS + 1, 3000);
    expect(resolveMeterEvidenceAtMs(state)).toBe(T0);
    const movedAtMs = nextPollMs(state);
    state = await sample(state, 4130, movedAtMs, 3000);
    expectLive(state);
    expect(state.unreliablePeriods).toContainEqual({ start: T0, end: movedAtMs });
  });

  it('leaves a frozen stretch unreliable up to its last sample when a sampling reset ends it', async () => {
    let state = await hold(await settledHold(1100), 1100, FREEZE_POLLS + 1, 3000);
    const lastFrozenSampleMs = state.lastTimestamp ?? T0;
    // Two days without a sample: nothing is booked across the gap, so it is
    // not the frozen stretch's to flag.
    state = await sample(state, 1100, lastFrozenSampleMs + MAX_POWER_SAMPLE_GAP_MS + 60_000, 3000);
    expect(state.unreliablePeriods).toEqual([{ start: T0, end: lastFrozenSampleMs }]);
  });

  it('leaves only the contradicted run unreliable when the reading was merely suspect', async () => {
    let state = await settledHold(1100);
    const contradictedAtMs = nextPollMs(state);
    state = await hold(state, 1100, SUSPECT_POLLS + 1, 3000);
    const movedAtMs = nextPollMs(state);
    state = await sample(state, 4130, movedAtMs, 3000);
    expect(state.unreliablePeriods).toEqual([{ start: contradictedAtMs, end: movedAtMs }]);
  });

  it('ages a tracker stored before the hold existed from its last sample', () => {
    expectLive({ lastPowerW: 1100, lastTimestamp: T0 });
  });
});
