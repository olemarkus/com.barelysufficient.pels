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
    monitor.noteSampleAdmitted();
    state.nowMs = T0 + POWER_SAMPLE_STALE_SHED_TIMEOUT_MS - 1;
    expect(monitor.isBlocked()).toBe(false);
    expect(monitor.shouldRunShedPass()).toBe(false);
  });

  it('owes exactly one shed pass at the timeout, then blocks until data returns', () => {
    const { monitor, state } = build(T0);
    monitor.noteSampleAdmitted();
    state.nowMs = T0 + POWER_SAMPLE_STALE_SHED_TIMEOUT_MS;

    // The pass is owed and the gate must let it through.
    expect(monitor.shouldRunShedPass()).toBe(true);
    expect(monitor.isBlocked()).toBe(false);

    monitor.noteShedPassCompleted(T0);
    expect(monitor.shouldRunShedPass()).toBe(false);
    expect(monitor.isBlocked()).toBe(true);

    // Data returns: the admitted ingest moved the tracker latch and clears
    // the block on the same edge.
    state.lastSampleAtMs = state.nowMs;
    monitor.noteSampleAdmitted();
    expect(monitor.isBlocked()).toBe(false);

    // A LATER silence re-arms the protocol against the new timestamp.
    state.nowMs += POWER_SAMPLE_STALE_SHED_TIMEOUT_MS;
    expect(monitor.shouldRunShedPass()).toBe(true);
  });

  it('a sample racing in during the pass re-arms rather than being swallowed by the latch', () => {
    const { monitor, state } = build(T0);
    monitor.noteSampleAdmitted();
    state.nowMs = T0 + POWER_SAMPLE_STALE_SHED_TIMEOUT_MS;
    // The escalation latched against the OLD timestamp; a racing sample moved it.
    monitor.noteShedPassCompleted(T0);
    state.lastSampleAtMs = state.nowMs - 1;
    monitor.noteSampleAdmitted();
    expect(monitor.isBlocked()).toBe(false);
    state.nowMs += POWER_SAMPLE_STALE_SHED_TIMEOUT_MS;
    expect(monitor.shouldRunShedPass()).toBe(true);
  });

  it('blocks a restored pre-restart silence immediately and owes it NO shed pass', () => {
    // A timestamp restored across a restart, already past the timeout: a
    // boot-time blind shed is exactly what the old restart grace prevented;
    // blocking until this process's first admitted sample replaces it.
    const { monitor } = build(T0 - POWER_SAMPLE_STALE_SHED_TIMEOUT_MS);
    expect(monitor.isBlocked()).toBe(true);
    expect(monitor.shouldRunShedPass()).toBe(false);
  });

  it('a restored timestamp still inside the timeout crosses as a live silence: pass owed, then blocked', () => {
    // Restart with a 2-minute-old restored latch and a meter that never
    // reports again. The silence completes in THIS process, so it is owed
    // its one fail-closed pass — freezing the pre-restart posture forever
    // is the one thing this must not do.
    const { monitor, state } = build(T0);
    // A gate/escalation read while still fresh witnesses the live-ish meter.
    state.nowMs = T0 + 2 * 60_000;
    expect(monitor.isBlocked()).toBe(false);
    // No sample is ever admitted; the timeout passes in-process.
    state.nowMs = T0 + POWER_SAMPLE_STALE_SHED_TIMEOUT_MS;
    expect(monitor.shouldRunShedPass()).toBe(true);
    expect(monitor.isBlocked()).toBe(false);
    monitor.noteShedPassCompleted(T0);
    expect(monitor.isBlocked()).toBe(true);
    expect(monitor.shouldRunShedPass()).toBe(false);
  });

  it('logs the block edge once per engagement, and the clear once per recovery', () => {
    const { monitor, state, log } = build(T0 - POWER_SAMPLE_STALE_SHED_TIMEOUT_MS);
    monitor.isBlocked();
    monitor.isBlocked();
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.warn).toHaveBeenCalledWith(expect.objectContaining({
      event: 'meter_silence_block_engaged',
      reasonCode: 'restored_silence',
    }));

    state.lastSampleAtMs = T0;
    monitor.noteSampleAdmitted();
    expect(log.info).toHaveBeenCalledWith(expect.objectContaining({ event: 'meter_silence_block_cleared' }));
    expect(log.info).toHaveBeenCalledTimes(1);
  });
});
