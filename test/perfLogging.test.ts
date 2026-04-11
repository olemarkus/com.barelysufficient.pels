import { incPerfCounter } from '../lib/utils/perfCounters';
import { startPerfLogger } from '../lib/app/perfLogging';

const resolveSmapsSummaryMock = vi.fn();
const startCpuSpikeMonitorMock = vi.fn((params: unknown) => {
  void params;
  return vi.fn();
});

vi.mock('../lib/app/smapsRollup', () => ({
  resolveSmapsSummary: () => resolveSmapsSummaryMock(),
}));

vi.mock('../lib/utils/cpuSpikeMonitor', () => ({
  startCpuSpikeMonitor: (params: unknown) => startCpuSpikeMonitorMock(params),
}));

describe('startPerfLogger', () => {
  beforeEach(() => {
    vi.useFakeTimers().setSystemTime(new Date('2026-01-26T12:00:00Z'));
    startCpuSpikeMonitorMock.mockClear();
    resolveSmapsSummaryMock.mockReset();
    resolveSmapsSummaryMock.mockReturnValue({
      rssMb: 123,
      pssMb: 111,
      pssAnonMb: 88,
      pssFileMb: 23,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('logs counters and deltas when enabled', () => {
    const log = vi.fn();
    incPerfCounter('plan_rebuild_total');

    const stop = startPerfLogger({
      isEnabled: () => true,
      log,
      intervalMs: 1000,
    });

    expect(log).toHaveBeenCalledTimes(1);

    incPerfCounter('plan_rebuild_total');
    vi.advanceTimersByTime(1000);

    expect(log).toHaveBeenCalledTimes(2);
    const message = log.mock.calls[1][0] as string;
    const jsonStart = message.indexOf('{');
    expect(jsonStart).toBeGreaterThan(-1);
    const payload = JSON.parse(message.slice(jsonStart)) as {
      smaps?: Record<string, number> | null;
      totals?: unknown;
      delta?: { counts?: Record<string, number> };
    };
    expect(payload.smaps).toEqual({
      rssMb: 123,
      pssMb: 111,
      pssAnonMb: 88,
      pssFileMb: 23,
    });
    expect(payload.delta?.counts?.plan_rebuild_total).toBe(1);
    expect(payload.totals).toBeUndefined();

    stop();
  });

  it('emits all non-zero counters in delta', () => {
    const log = vi.fn();
    incPerfCounter('plan_rebuild_total');
    incPerfCounter('plan_rebuild_skipped_reason.danger_zone_sustained_total');

    const stop = startPerfLogger({
      isEnabled: () => true,
      log,
      intervalMs: 1000,
    });

    incPerfCounter('plan_rebuild_total');
    incPerfCounter('plan_rebuild_skipped_reason.danger_zone_sustained_total');
    vi.advanceTimersByTime(1000);

    const message = log.mock.calls[1][0] as string;
    const jsonStart = message.indexOf('{');
    const payload = JSON.parse(message.slice(jsonStart)) as { delta?: { counts?: Record<string, number> } };
    expect(payload.delta?.counts?.plan_rebuild_total).toBe(1);
    expect(payload.delta?.counts?.['plan_rebuild_skipped_reason.danger_zone_sustained_total']).toBe(1);

    stop();
  });

  it('computes rebuildSkipRate against power samples', () => {
    const log = vi.fn();
    const stop = startPerfLogger({
      isEnabled: () => true,
      log,
      intervalMs: 1000,
    });

    incPerfCounter('power_sample_total', 4);
    incPerfCounter('plan_rebuild_skipped_total', 2);
    incPerfCounter('plan_rebuild_total', 1);
    vi.advanceTimersByTime(1000);

    const message = log.mock.calls[1][0] as string;
    const jsonStart = message.indexOf('{');
    const payload = JSON.parse(message.slice(jsonStart)) as { summary?: { rebuildSkipRate?: number } };
    expect(payload.summary?.rebuildSkipRate).toBe(0.5);

    stop();
  });

  it('skips logging when disabled', () => {
    const log = vi.fn();
    const stop = startPerfLogger({
      isEnabled: () => false,
      log,
      intervalMs: 1000,
    });

    vi.advanceTimersByTime(3000);
    expect(log).not.toHaveBeenCalled();

    stop();
  });

  it('starts and stops cpu spike monitor when configured', () => {
    const log = vi.fn();
    const logCpuSpike = vi.fn();
    const stopCpuMonitor = vi.fn();
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
    const log = vi.fn();

    const stop = startPerfLogger({
      isEnabled: () => true,
      log,
      intervalMs: 1000,
    });

    expect(startCpuSpikeMonitorMock).not.toHaveBeenCalled();

    stop();
  });

  it('starts cpu spike monitor only after perf logging becomes enabled', () => {
    const log = vi.fn();
    const logCpuSpike = vi.fn();
    const stopCpuMonitor = vi.fn();
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
    vi.advanceTimersByTime(1000);
    expect(startCpuSpikeMonitorMock).toHaveBeenCalledTimes(1);

    enabled = false;
    vi.advanceTimersByTime(1000);
    expect(stopCpuMonitor).toHaveBeenCalledTimes(1);

    stop();
  });
});
