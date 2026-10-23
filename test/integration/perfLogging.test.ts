import { captureDebugTopic } from '../utils/loggerCapture';
import { incPerfCounter } from '../../lib/utils/perfCounters';
import { startPerfLogger } from '../../lib/diagnostics/perfLogging';

const resolveSmapsSummaryMock = vi.fn();
const startCpuSpikeMonitorMock = vi.fn((params: unknown) => {
  void params;
  return vi.fn();
});

vi.mock('../../lib/diagnostics/smapsRollup', () => ({
  resolveSmapsSummary: () => resolveSmapsSummaryMock(),
  resolveSmapsDetail: () => null,
}));

vi.mock('../../lib/utils/cpuSpikeMonitor', () => ({
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
    incPerfCounter('plan_rebuild_total');

    const perfDebug = captureDebugTopic('perf');
    const stop = startPerfLogger({ intervalMs: 1000 });

    expect(perfDebug.events()).toHaveLength(1);

    incPerfCounter('plan_rebuild_total');
    vi.advanceTimersByTime(1000);

    expect(perfDebug.events()).toHaveLength(2);
    const payload = perfDebug.events()[1] as {
      event?: string;
      smaps?: Record<string, number> | null;
      totals?: unknown;
      delta?: { counts?: Record<string, number> };
    };
    expect(payload.event).toBe('perf_counters');
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
    incPerfCounter('plan_rebuild_total');
    incPerfCounter('plan_rebuild_skipped_insignificant_total');
    incPerfCounter('plan_rebuild_skipped_non_boundary_delta_total');

    const perfDebug = captureDebugTopic('perf');
    const stop = startPerfLogger({ intervalMs: 1000 });

    incPerfCounter('plan_rebuild_total');
    incPerfCounter('plan_rebuild_skipped_insignificant_total');
    incPerfCounter('plan_rebuild_skipped_non_boundary_delta_total');
    vi.advanceTimersByTime(1000);

    const payload = perfDebug.events()[1] as { delta?: { counts?: Record<string, number> } };
    expect(payload.delta?.counts?.plan_rebuild_total).toBe(1);
    expect(payload.delta?.counts?.plan_rebuild_skipped_insignificant_total).toBe(1);
    expect(payload.delta?.counts?.plan_rebuild_skipped_non_boundary_delta_total).toBe(1);

    stop();
  });

  it('computes rebuildSkipRate against power samples', () => {
    const perfDebug = captureDebugTopic('perf');
    const stop = startPerfLogger({ intervalMs: 1000 });

    incPerfCounter('power_sample_total', 4);
    incPerfCounter('plan_rebuild_skipped_total', 2);
    incPerfCounter('plan_rebuild_total', 1);
    vi.advanceTimersByTime(1000);

    const payload = perfDebug.events()[1] as { summary?: { rebuildSkipRate?: number } };
    expect(payload.summary?.rebuildSkipRate).toBe(0.5);

    stop();
  });

  it('skips logging when disabled', () => {
    const perfDebug = captureDebugTopic('perf', { enabled: false });
    const stop = startPerfLogger({ intervalMs: 1000 });

    vi.advanceTimersByTime(3000);
    expect(perfDebug.events()).toHaveLength(0);

    stop();
  });

  it('starts and stops the cpu spike monitor with perf logging', () => {
    const stopCpuMonitor = vi.fn();
    startCpuSpikeMonitorMock.mockReturnValueOnce(stopCpuMonitor);

    captureDebugTopic('perf');
    const stop = startPerfLogger({ intervalMs: 1000 });

    expect(startCpuSpikeMonitorMock).toHaveBeenCalledTimes(1);
    expect(startCpuSpikeMonitorMock.mock.calls[0]?.[0]).toEqual(expect.objectContaining({
      isEnabled: expect.any(Function),
    }));

    stop();

    expect(stopCpuMonitor).toHaveBeenCalledTimes(1);
  });

  it('starts cpu spike monitor only after perf logging becomes enabled', () => {
    const stopCpuMonitor = vi.fn();
    captureDebugTopic('perf', { enabled: false });
    startCpuSpikeMonitorMock.mockReturnValueOnce(stopCpuMonitor);

    const stop = startPerfLogger({ intervalMs: 1000 });

    expect(startCpuSpikeMonitorMock).not.toHaveBeenCalled();

    captureDebugTopic('perf');
    vi.advanceTimersByTime(1000);
    expect(startCpuSpikeMonitorMock).toHaveBeenCalledTimes(1);

    captureDebugTopic('perf', { enabled: false });
    vi.advanceTimersByTime(1000);
    expect(stopCpuMonitor).toHaveBeenCalledTimes(1);

    stop();
  });
});
