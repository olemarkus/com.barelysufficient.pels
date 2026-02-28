import { incPerfCounter } from '../lib/utils/perfCounters';
import { startPerfLogger } from '../lib/app/perfLogging';

const startCpuSpikeMonitorMock = jest.fn((params: unknown) => {
  void params;
  return jest.fn();
});

jest.mock('../lib/utils/cpuSpikeMonitor', () => ({
  startCpuSpikeMonitor: (params: unknown) => startCpuSpikeMonitorMock(params),
}));

describe('startPerfLogger', () => {
  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(new Date('2026-01-26T12:00:00Z'));
    startCpuSpikeMonitorMock.mockClear();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('logs counters and deltas when enabled', () => {
    const log = jest.fn();
    incPerfCounter('plan_rebuild_total');

    const stop = startPerfLogger({
      isEnabled: () => true,
      log,
      intervalMs: 1000,
    });

    expect(log).toHaveBeenCalledTimes(1);

    incPerfCounter('plan_rebuild_total');
    jest.advanceTimersByTime(1000);

    expect(log).toHaveBeenCalledTimes(2);
    const message = log.mock.calls[1][0] as string;
    const jsonStart = message.indexOf('{');
    expect(jsonStart).toBeGreaterThan(-1);
    const payload = JSON.parse(message.slice(jsonStart)) as {
      totals?: unknown;
      delta?: { counts?: Record<string, number> };
    };
    expect(payload.delta?.counts?.plan_rebuild_total).toBe(1);
    expect(payload.totals).toBeUndefined();

    stop();
  });

  it('filters out low-value counters from delta', () => {
    const log = jest.fn();
    incPerfCounter('plan_rebuild_total');
    incPerfCounter('perf.logging.ignored');

    const stop = startPerfLogger({
      isEnabled: () => true,
      log,
      intervalMs: 1000,
    });

    incPerfCounter('plan_rebuild_total');
    incPerfCounter('perf.logging.ignored');
    jest.advanceTimersByTime(1000);

    const message = log.mock.calls[1][0] as string;
    const jsonStart = message.indexOf('{');
    const payload = JSON.parse(message.slice(jsonStart)) as { delta?: { counts?: Record<string, number> } };
    expect(payload.delta?.counts?.plan_rebuild_total).toBe(1);
    expect(payload.delta?.counts?.['perf.logging.ignored']).toBeUndefined();

    stop();
  });

  it('computes rebuildSkipRate against power samples', () => {
    const log = jest.fn();
    const stop = startPerfLogger({
      isEnabled: () => true,
      log,
      intervalMs: 1000,
    });

    incPerfCounter('power_sample_total', 4);
    incPerfCounter('plan_rebuild_skipped_total', 2);
    incPerfCounter('plan_rebuild_total', 1);
    jest.advanceTimersByTime(1000);

    const message = log.mock.calls[1][0] as string;
    const jsonStart = message.indexOf('{');
    const payload = JSON.parse(message.slice(jsonStart)) as { summary?: { rebuildSkipRate?: number } };
    expect(payload.summary?.rebuildSkipRate).toBe(0.5);

    stop();
  });

  it('skips logging when disabled', () => {
    const log = jest.fn();
    const stop = startPerfLogger({
      isEnabled: () => false,
      log,
      intervalMs: 1000,
    });

    jest.advanceTimersByTime(3000);
    expect(log).not.toHaveBeenCalled();

    stop();
  });

  it('starts and stops cpu spike monitor when configured', () => {
    const log = jest.fn();
    const logCpuSpike = jest.fn();
    const stopCpuMonitor = jest.fn();
    startCpuSpikeMonitorMock.mockReturnValueOnce(stopCpuMonitor);

    const stop = startPerfLogger({
      isEnabled: () => true,
      log,
      logCpuSpike,
      intervalMs: 1000,
    });

    expect(startCpuSpikeMonitorMock).toHaveBeenCalledTimes(1);
    expect(startCpuSpikeMonitorMock.mock.calls[0]?.[0]).toEqual(expect.objectContaining({
      log: logCpuSpike,
      isEnabled: expect.any(Function),
    }));

    stop();

    expect(stopCpuMonitor).toHaveBeenCalledTimes(1);
  });

  it('does not start cpu spike monitor when not configured', () => {
    const log = jest.fn();

    const stop = startPerfLogger({
      isEnabled: () => true,
      log,
      intervalMs: 1000,
    });

    expect(startCpuSpikeMonitorMock).not.toHaveBeenCalled();

    stop();
  });

  it('starts cpu spike monitor only after perf logging becomes enabled', () => {
    const log = jest.fn();
    const logCpuSpike = jest.fn();
    const stopCpuMonitor = jest.fn();
    let enabled = false;
    startCpuSpikeMonitorMock.mockReturnValueOnce(stopCpuMonitor);

    const stop = startPerfLogger({
      isEnabled: () => enabled,
      log,
      logCpuSpike,
      intervalMs: 1000,
    });

    expect(startCpuSpikeMonitorMock).not.toHaveBeenCalled();

    enabled = true;
    jest.advanceTimersByTime(1000);
    expect(startCpuSpikeMonitorMock).toHaveBeenCalledTimes(1);

    enabled = false;
    jest.advanceTimersByTime(1000);
    expect(stopCpuMonitor).toHaveBeenCalledTimes(1);

    stop();
  });
});
