import { MeterSilenceMonitor, type MeterSilence } from '../../lib/power/meterSilence';
import { POWER_SAMPLE_STALE_SHED_TIMEOUT_MS } from '../../lib/power/sampleFreshness';
import { HELD_READING_FREEZE_MS, HELD_READING_SUSPECT_MS } from '../../lib/power/heldReading';
import { recordPowerSample } from '../../lib/power/tracker';
import type { PowerTrackerState } from '../../lib/power/trackerTypes';
import { MAIN_HOME_ID } from '../../lib/utils/settingsKeys';

const T0 = Date.UTC(2026, 3, 18, 10, 0, 0);

/** A silence whose samples stopped, dating from `silentSinceMs`. */
const noSamplesSince = (silentSinceMs: number): MeterSilence => ({ silentSinceMs, cause: 'no_samples' });

const build = (initialLastSampleAtMs?: number) => {
  const state = { lastSampleAtMs: initialLastSampleAtMs, nowMs: T0 };
  const log = { info: vi.fn(), warn: vi.fn() };
  const monitor = new MeterSilenceMonitor({
    homeId: MAIN_HOME_ID,
    getPowerTracker: () => ({ lastTimestamp: state.lastSampleAtMs }),
    nowMs: () => state.nowMs,
    structuredLog: () => log,
  });
  return { monitor, state, log };
};

describe('MeterSilenceMonitor — the 10-minute silence policy', () => {
  it('never blocks a home that has never sampled — the measurement gate owns that', () => {
    const { monitor } = build(undefined);
    expect(monitor.isBlocked()).toBe(false);
    expect(monitor.shedPassOwedFor()).toBeNull();
  });

  it('neither blocks nor owes a pass while the sample is inside the timeout', () => {
    const { monitor, state } = build(T0);
    state.nowMs = T0 + POWER_SAMPLE_STALE_SHED_TIMEOUT_MS - 1;
    expect(monitor.isBlocked()).toBe(false);
    expect(monitor.shedPassOwedFor()).toBeNull();
  });

  it('owes exactly one shed pass at the timeout, then blocks until data returns', () => {
    const { monitor, state } = build(T0);
    state.nowMs = T0 + POWER_SAMPLE_STALE_SHED_TIMEOUT_MS;

    // The pass is owed and the gate must let it through.
    expect(monitor.shedPassOwedFor()).toEqual(noSamplesSince(T0));
    expect(monitor.isBlocked()).toBe(false);

    monitor.noteShedPassCompleted(noSamplesSince(T0));
    expect(monitor.shedPassOwedFor()).toBeNull();
    expect(monitor.isBlocked()).toBe(true);

    // Data returns: the admitted ingest moved the tracker latch, and the
    // next read of the gate sees the block gone.
    state.lastSampleAtMs = state.nowMs;
    expect(monitor.isBlocked()).toBe(false);

    // A LATER silence re-arms the protocol against the new timestamp.
    const newStamp = state.lastSampleAtMs;
    state.nowMs += POWER_SAMPLE_STALE_SHED_TIMEOUT_MS;
    expect(monitor.shedPassOwedFor()).toEqual(noSamplesSince(newStamp));
  });

  it('a sample racing in during the pass re-arms rather than being swallowed by the latch', () => {
    const { monitor, state } = build(T0);
    state.nowMs = T0 + POWER_SAMPLE_STALE_SHED_TIMEOUT_MS;
    // The escalation latched against the OLD timestamp; a racing sample moved it.
    monitor.noteShedPassCompleted(noSamplesSince(T0));
    state.lastSampleAtMs = state.nowMs - 1;
    expect(monitor.isBlocked()).toBe(false);
    state.nowMs += POWER_SAMPLE_STALE_SHED_TIMEOUT_MS;
    expect(monitor.shedPassOwedFor()).toEqual(noSamplesSince(state.lastSampleAtMs));
  });

  it('a stamp restored across a restart already past the timeout is owed its pass at once', () => {
    // Ten minutes without a reading is a ten-minute outage whether or not
    // this process was up for all of it: the restored stamp ages exactly as
    // a live one, and older evidence of a dead meter never buys LESS
    // protection than fresher evidence.
    const restoredTs = T0 - POWER_SAMPLE_STALE_SHED_TIMEOUT_MS;
    const { monitor } = build(restoredTs);
    expect(monitor.shedPassOwedFor()).toEqual(noSamplesSince(restoredTs));
    expect(monitor.isBlocked()).toBe(false);
    monitor.noteShedPassCompleted(noSamplesSince(restoredTs));
    expect(monitor.shedPassOwedFor()).toBeNull();
    expect(monitor.isBlocked()).toBe(true);
  });

  it('a stamp restored across a restart still inside the timeout completes its silence here', () => {
    // Restart with a 2-minute-old restored latch and a meter that never
    // reports again: no admitted sample in this process, the timeout passes
    // on the stamp's own clock, and the pass is owed then.
    const { monitor, state } = build(T0);
    state.nowMs = T0 + 2 * 60_000;
    expect(monitor.isBlocked()).toBe(false);
    expect(monitor.shedPassOwedFor()).toBeNull();
    state.nowMs = T0 + POWER_SAMPLE_STALE_SHED_TIMEOUT_MS;
    expect(monitor.shedPassOwedFor()).toEqual(noSamplesSince(T0));
    expect(monitor.isBlocked()).toBe(false);
    monitor.noteShedPassCompleted(noSamplesSince(T0));
    expect(monitor.isBlocked()).toBe(true);
    expect(monitor.shedPassOwedFor()).toBeNull();
  });

  it('logs the block edge once per engagement, and the clear once per recovery', () => {
    const { monitor, state, log } = build(T0 - POWER_SAMPLE_STALE_SHED_TIMEOUT_MS);
    monitor.noteShedPassCompleted(noSamplesSince(T0 - POWER_SAMPLE_STALE_SHED_TIMEOUT_MS));
    monitor.isBlocked();
    monitor.isBlocked();
    // One warn for the completed pass, one for the block edge — never a second block edge.
    expect(log.warn).toHaveBeenCalledTimes(2);
    expect(log.warn).toHaveBeenCalledWith(expect.objectContaining({
      event: 'meter_silence_block_engaged',
      silentSinceMs: T0 - POWER_SAMPLE_STALE_SHED_TIMEOUT_MS,
      cause: 'no_samples',
    }));

    state.lastSampleAtMs = T0;
    expect(monitor.isBlocked()).toBe(false);
    expect(log.info).toHaveBeenCalledWith(expect.objectContaining({ event: 'meter_silence_block_cleared' }));
    expect(log.info).toHaveBeenCalledTimes(1);
  });

  // Samples keep arriving (the driver repeats its last value) while the
  // metered load has sat 3 kW away from the held reading since `contradictedAtMs`.
  const heldTracker = (contradictedAtMs: number): PowerTrackerState => ({
    lastPowerW: 1100,
    lastTimestamp: T0,
    heldReading: {
      powerW: 1100,
      sinceMs: T0 - 2 * POWER_SAMPLE_STALE_SHED_TIMEOUT_MS,
      atMs: T0,
      baseline: { totalW: 0, loadKey: 1 },
      contradictedAtMs,
      longHoldEndedAtMs: null,
    },
  });

  const monitorOf = (tracker: () => PowerTrackerState, nowMs: () => number, log: { info: () => void; warn: () => void }) => (
    new MeterSilenceMonitor({ homeId: MAIN_HOME_ID, getPowerTracker: tracker, nowMs, structuredLog: () => log })
  );

  it('treats a frozen reading as silent since it took its value, and says so', () => {
    const log = { info: vi.fn(), warn: vi.fn() };
    const monitor = monitorOf(() => heldTracker(T0 - HELD_READING_FREEZE_MS), () => T0, log);
    const frozen: MeterSilence = { silentSinceMs: T0 - 2 * POWER_SAMPLE_STALE_SHED_TIMEOUT_MS, cause: 'frozen_reading' };
    expect(monitor.shedPassOwedFor()).toEqual(frozen);
    monitor.noteShedPassCompleted(frozen);
    expect(log.warn).toHaveBeenCalledWith({ event: 'meter_silence_shed_pass_completed', homeId: MAIN_HOME_ID, ...frozen });
  });

  it('owes nothing for a reading that is only suspect: the owner is warned, control waits', () => {
    const monitor = monitorOf(() => heldTracker(T0 - HELD_READING_SUSPECT_MS), () => T0, { info: vi.fn(), warn: vi.fn() });
    expect(monitor.shedPassOwedFor()).toBeNull();
    expect(monitor.isBlocked()).toBe(false);
  });

  it('owes a frozen reading its own pass, though it dates from where a no-samples silence ended', async () => {
    const POLL_MS = 10_000;
    const record = async (state: PowerTrackerState, nowMs: number, managedDrawW: number): Promise<PowerTrackerState> => {
      const saveState = vi.fn();
      await recordPowerSample({
        generationSegments: [],
        timeZone: 'UTC',
        state,
        currentPowerW: 1100,
        managedDraw: { totalW: managedDrawW, loadKey: 1 },
        nowMs,
        rebuildPlanFromCache: vi.fn().mockResolvedValue(undefined),
        saveState,
      });
      return saveState.mock.calls[0][0] as PowerTrackerState;
    };
    // The meter's last delivery before it went quiet carried a new value.
    let tracker = await record({ lastPowerW: 1000, lastTimestamp: T0 - POLL_MS }, T0, 0);
    let nowMs = T0 + POWER_SAMPLE_STALE_SHED_TIMEOUT_MS;
    const monitor = monitorOf(() => tracker, () => nowMs, { info: vi.fn(), warn: vi.fn() });
    expect(monitor.shedPassOwedFor()).toEqual(noSamplesSince(T0));
    monitor.noteShedPassCompleted(noSamplesSince(T0));
    expect(monitor.isBlocked()).toBe(true);

    // Deliveries resume on the same value: evidence again, so the block lifts.
    nowMs += POLL_MS;
    tracker = await record(tracker, nowMs, 0);
    expect(monitor.isBlocked()).toBe(false);

    // Then 3 kW of load comes on and the reading never follows: frozen, and
    // dated from T0 again, but it is a different silence, owed its own pass.
    for (let poll = 0; poll <= HELD_READING_FREEZE_MS / POLL_MS; poll += 1) {
      nowMs += POLL_MS;
      tracker = await record(tracker, nowMs, 3000);
    }
    expect(monitor.shedPassOwedFor()).toEqual({ silentSinceMs: T0, cause: 'frozen_reading' });
    expect(monitor.isBlocked()).toBe(false);
  });
});
