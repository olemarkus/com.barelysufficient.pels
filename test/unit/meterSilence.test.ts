import { MeterSilenceMonitor } from '../../lib/power/meterSilence';
import { POWER_SAMPLE_STALE_SHED_TIMEOUT_MS } from '../../lib/power/sampleFreshness';

const T0 = Date.UTC(2026, 3, 18, 10, 0, 0);

const build = (initialLastSampleAtMs?: number) => {
  const state = { lastSampleAtMs: initialLastSampleAtMs, nowMs: T0 };
  const log = { info: vi.fn(), warn: vi.fn() };
  const monitor = new MeterSilenceMonitor({
    getLastSampleAtMs: () => state.lastSampleAtMs,
    nowMs: () => state.nowMs,
    structuredLog: () => log,
  });
  return { monitor, state, log };
};

describe('MeterSilenceMonitor — the 10-minute silence policy', () => {
  it('never blocks a home that has never sampled — the measurement gate owns that', () => {
    const { monitor } = build(undefined);
    expect(monitor.isBlocked()).toBe(false);
    expect(monitor.shouldRunShedPass()).toBe(false);
  });

  it('neither blocks nor owes a pass while the sample is inside the timeout', () => {
    const { monitor, state } = build(T0);
    state.nowMs = T0 + POWER_SAMPLE_STALE_SHED_TIMEOUT_MS - 1;
    expect(monitor.isBlocked()).toBe(false);
    expect(monitor.shouldRunShedPass()).toBe(false);
  });

  it('owes exactly one shed pass at the timeout, then blocks until data returns', () => {
    const { monitor, state } = build(T0);
    state.nowMs = T0 + POWER_SAMPLE_STALE_SHED_TIMEOUT_MS;

    // The pass is owed and the gate must let it through.
    expect(monitor.shouldRunShedPass()).toBe(true);
    expect(monitor.isBlocked()).toBe(false);

    monitor.noteShedPassCompleted(T0);
    expect(monitor.shouldRunShedPass()).toBe(false);
    expect(monitor.isBlocked()).toBe(true);

    // Data returns: the admitted ingest moved the tracker latch, and the
    // next read of the gate sees the block gone.
    state.lastSampleAtMs = state.nowMs;
    expect(monitor.isBlocked()).toBe(false);

    // A LATER silence re-arms the protocol against the new timestamp.
    state.nowMs += POWER_SAMPLE_STALE_SHED_TIMEOUT_MS;
    expect(monitor.shouldRunShedPass()).toBe(true);
  });

  it('a sample racing in during the pass re-arms rather than being swallowed by the latch', () => {
    const { monitor, state } = build(T0);
    state.nowMs = T0 + POWER_SAMPLE_STALE_SHED_TIMEOUT_MS;
    // The escalation latched against the OLD timestamp; a racing sample moved it.
    monitor.noteShedPassCompleted(T0);
    state.lastSampleAtMs = state.nowMs - 1;
    expect(monitor.isBlocked()).toBe(false);
    state.nowMs += POWER_SAMPLE_STALE_SHED_TIMEOUT_MS;
    expect(monitor.shouldRunShedPass()).toBe(true);
  });

  it('a stamp restored across a restart already past the timeout is owed its pass at once', () => {
    // Ten minutes without a reading is a ten-minute outage whether or not
    // this process was up for all of it: the restored stamp ages exactly as
    // a live one, and older evidence of a dead meter never buys LESS
    // protection than fresher evidence.
    const restoredTs = T0 - POWER_SAMPLE_STALE_SHED_TIMEOUT_MS;
    const { monitor } = build(restoredTs);
    expect(monitor.shouldRunShedPass()).toBe(true);
    expect(monitor.isBlocked()).toBe(false);
    monitor.noteShedPassCompleted(restoredTs);
    expect(monitor.shouldRunShedPass()).toBe(false);
    expect(monitor.isBlocked()).toBe(true);
  });

  it('a stamp restored across a restart still inside the timeout completes its silence here', () => {
    // Restart with a 2-minute-old restored latch and a meter that never
    // reports again: no admitted sample in this process, the timeout passes
    // on the stamp's own clock, and the pass is owed then.
    const { monitor, state } = build(T0);
    state.nowMs = T0 + 2 * 60_000;
    expect(monitor.isBlocked()).toBe(false);
    expect(monitor.shouldRunShedPass()).toBe(false);
    state.nowMs = T0 + POWER_SAMPLE_STALE_SHED_TIMEOUT_MS;
    expect(monitor.shouldRunShedPass()).toBe(true);
    expect(monitor.isBlocked()).toBe(false);
    monitor.noteShedPassCompleted(T0);
    expect(monitor.isBlocked()).toBe(true);
    expect(monitor.shouldRunShedPass()).toBe(false);
  });

  it('logs the block edge once per engagement, and the clear once per recovery', () => {
    const { monitor, state, log } = build(T0 - POWER_SAMPLE_STALE_SHED_TIMEOUT_MS);
    monitor.noteShedPassCompleted(T0 - POWER_SAMPLE_STALE_SHED_TIMEOUT_MS);
    monitor.isBlocked();
    monitor.isBlocked();
    // One warn for the completed pass, one for the block edge — never a second block edge.
    expect(log.warn).toHaveBeenCalledTimes(2);
    expect(log.warn).toHaveBeenCalledWith(expect.objectContaining({ event: 'meter_silence_block_engaged' }));

    state.lastSampleAtMs = T0;
    expect(monitor.isBlocked()).toBe(false);
    expect(log.info).toHaveBeenCalledWith(expect.objectContaining({ event: 'meter_silence_block_cleared' }));
    expect(log.info).toHaveBeenCalledTimes(1);
  });
});
