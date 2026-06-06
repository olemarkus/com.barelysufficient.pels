import type { MockInstance } from 'vitest';
import { startCpuSpikeMonitor } from '../../lib/utils/cpuSpikeMonitor';
import { captureLogger, type LoggerCapture } from '../utils/loggerCapture';

describe('startCpuSpikeMonitor', () => {
  let cpuUsageSpy: MockInstance;
  let hrtimeSpy: MockInstance;
  let capture: LoggerCapture;

  beforeEach(() => {
    capture = captureLogger();
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
    capture.restore();
    vi.useRealTimers();
  });

  it('uses the clamped interval for delay detection and logging', () => {
    const stop = startCpuSpikeMonitor({
      sampleIntervalMs: 100,
      cpuThresholdPct: 0,
      minConsecutiveSamples: 2,
      minLogIntervalMs: 0,
    });

    expect(capture.findEvent('cpu_spike_monitor_started')).toMatchObject({
      intervalMs: 250,
      thresholdPct: 0,
    });

    vi.advanceTimersByTime(250);
    expect(capture.findEvents('cpu_spike_detected')).toHaveLength(0);

    vi.advanceTimersByTime(250);
    const spikes = capture.findEvents('cpu_spike_detected');
    expect(spikes).toHaveLength(1);
    expect(spikes[0]).toMatchObject({ lagMs: 0 });

    stop();
  });

  it('does not log monitor startup while disabled', () => {
    const stop = startCpuSpikeMonitor({
      isEnabled: () => false,
      sampleIntervalMs: 100,
      cpuThresholdPct: 0,
      minConsecutiveSamples: 1,
      minLogIntervalMs: 0,
    });

    expect(capture.findEvent('cpu_spike_monitor_started')).toBeUndefined();

    vi.advanceTimersByTime(1000);
    expect(capture.findEvent('cpu_spike_monitor_started')).toBeUndefined();
    expect(capture.findEvents('cpu_spike_detected')).toHaveLength(0);

    stop();
  });

  it('emits a structured error event for monitor exceptions', () => {
    const stop = startCpuSpikeMonitor({
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

    const errorEvent = capture.findEvent('cpu_spike_monitor_error');
    expect(errorEvent).toBeDefined();
    expect((errorEvent?.err as Error | undefined)?.message).toBe('boom');
    stop();
  });

  it('normalizes non-Error monitor exceptions before logging', () => {
    const stop = startCpuSpikeMonitor({
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

    const errorEvent = capture.findEvent('cpu_spike_monitor_error');
    expect(errorEvent).toBeDefined();
    expect((errorEvent?.err as Error | undefined)?.message).toBe('boom');
    stop();
  });
});
