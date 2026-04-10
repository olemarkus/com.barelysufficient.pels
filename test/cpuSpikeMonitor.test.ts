import type { MockInstance } from 'vitest';
import { startCpuSpikeMonitor } from '../lib/utils/cpuSpikeMonitor';

describe('startCpuSpikeMonitor', () => {
  let cpuUsageSpy: MockInstance;
  let hrtimeSpy: MockInstance;

  beforeEach(() => {
    vi.useFakeTimers().setSystemTime(new Date('2026-02-28T08:00:00Z'));
    cpuUsageSpy = vi.spyOn(process, 'cpuUsage').mockImplementation((previous?: NodeJS.CpuUsage) => (
      previous ? { user: 0, system: 0 } : { user: 0, system: 0 }
    ));
    hrtimeSpy = vi.spyOn(process.hrtime, 'bigint').mockImplementation(() => (
      BigInt(Date.now()) * 1_000_000n
    ));
  });

  afterEach(() => {
    cpuUsageSpy.mockRestore();
    hrtimeSpy.mockRestore();
    vi.useRealTimers();
  });

  it('uses the clamped interval for delay detection and logging', () => {
    const log = vi.fn();

    const stop = startCpuSpikeMonitor({
      log,
      sampleIntervalMs: 100,
      cpuThresholdPct: 0,
      minConsecutiveSamples: 2,
      minLogIntervalMs: 0,
    });

    expect(log).toHaveBeenCalledWith('[perf] cpu spike monitor started interval=250ms threshold=0%');

    vi.advanceTimersByTime(250);
    let spikeMessages = log.mock.calls
      .map(([message]) => String(message))
      .filter((message) => message.includes('[perf] cpu spike cpu='));
    expect(spikeMessages).toHaveLength(0);

    vi.advanceTimersByTime(250);
    spikeMessages = log.mock.calls
      .map(([message]) => String(message))
      .filter((message) => message.includes('[perf] cpu spike cpu='));
    expect(spikeMessages).toHaveLength(1);
    expect(spikeMessages[0]).toContain('lag=0ms');

    stop();
  });

  it('does not log monitor startup while disabled', () => {
    const log = vi.fn();

    const stop = startCpuSpikeMonitor({
      log,
      isEnabled: () => false,
      sampleIntervalMs: 100,
      cpuThresholdPct: 0,
      minConsecutiveSamples: 1,
      minLogIntervalMs: 0,
    });

    expect(log).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1000);
    expect(log).not.toHaveBeenCalled();

    stop();
  });

  it('routes monitor exceptions to error when provided', () => {
    const log = vi.fn();
    const error = vi.fn();
    const stop = startCpuSpikeMonitor({
      log,
      error,
      sampleIntervalMs: 250,
      cpuThresholdPct: 0,
      minConsecutiveSamples: 1,
      minLogIntervalMs: 0,
    });
    cpuUsageSpy.mockImplementation((previous?: NodeJS.CpuUsage) => {
      if (previous) throw new Error('boom');
      return { user: 0, system: 0 };
    });

    vi.advanceTimersByTime(250);

    expect(error).toHaveBeenCalledWith('[perf] cpu spike monitor error boom', expect.any(Error));
    stop();
  });

  it('normalizes non-Error monitor exceptions before logging', () => {
    const error = vi.fn();
    const stop = startCpuSpikeMonitor({
      log: vi.fn(),
      error,
      sampleIntervalMs: 250,
      cpuThresholdPct: 0,
      minConsecutiveSamples: 1,
      minLogIntervalMs: 0,
    });
    cpuUsageSpy.mockImplementation((previous?: NodeJS.CpuUsage) => {
      if (previous) throw 'boom';
      return { user: 0, system: 0 };
    });

    vi.advanceTimersByTime(250);

    expect(error).toHaveBeenCalledWith('[perf] cpu spike monitor error boom', expect.any(Error));
    stop();
  });

  it('includes the normalized error when falling back to standard log output', () => {
    const log = vi.fn();
    const stop = startCpuSpikeMonitor({
      log,
      sampleIntervalMs: 250,
      cpuThresholdPct: 0,
      minConsecutiveSamples: 1,
      minLogIntervalMs: 0,
    });
    cpuUsageSpy.mockImplementation((previous?: NodeJS.CpuUsage) => {
      if (previous) throw 'boom';
      return { user: 0, system: 0 };
    });

    vi.advanceTimersByTime(250);

    expect(log).toHaveBeenCalledWith('[perf] cpu spike monitor error boom', expect.any(Error));
    stop();
  });
});
