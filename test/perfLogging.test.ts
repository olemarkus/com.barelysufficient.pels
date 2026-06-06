import { incPerfCounter } from '../lib/utils/perfCounters';
import { startPerfLogger } from '../lib/diagnostics/perfLogging';

const resolveSmapsSummaryMock = vi.fn();
const startCpuSpikeMonitorMock = vi.fn((params: unknown) => {
  void params;
  return vi.fn();
});

vi.mock('../lib/diagnostics/smapsRollup', () => ({
  resolveSmapsSummary: () => resolveSmapsSummaryMock(),
  resolveSmapsDetail: () => null,
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
    const logStructured = vi.fn();
    incPerfCounter('plan_rebuild_total');

    const stop = startPerfLogger({
      isEnabled: () => true,
      logStructured,
      intervalMs: 1000,
    });

    expect(logStructured).toHaveBeenCalledTimes(1);

    incPerfCounter('plan_rebuild_total');
    vi.advanceTimersByTime(1000);

    expect(logStructured).toHaveBeenCalledTimes(2);
    const payload = logStructured.mock.calls[1][0] as {
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
    const logStructured = vi.fn();
    incPerfCounter('plan_rebuild_total');
    incPerfCounter('plan_rebuild_skipped_insignificant_total');
    incPerfCounter('plan_rebuild_skipped_non_boundary_delta_total');

    const stop = startPerfLogger({
      isEnabled: () => true,
      logStructured,
      intervalMs: 1000,
    });

    incPerfCounter('plan_rebuild_total');
    incPerfCounter('plan_rebuild_skipped_insignificant_total');
    incPerfCounter('plan_rebuild_skipped_non_boundary_delta_total');
    vi.advanceTimersByTime(1000);

    const payload = logStructured.mock.calls[1][0] as { delta?: { counts?: Record<string, number> } };
    expect(payload.delta?.counts?.plan_rebuild_total).toBe(1);
    expect(payload.delta?.counts?.plan_rebuild_skipped_insignificant_total).toBe(1);
    expect(payload.delta?.counts?.plan_rebuild_skipped_non_boundary_delta_total).toBe(1);

    stop();
  });

  it('computes rebuildSkipRate against power samples', () => {
    const logStructured = vi.fn();
    const stop = startPerfLogger({
      isEnabled: () => true,
      logStructured,
      intervalMs: 1000,
    });

    incPerfCounter('power_sample_total', 4);
    incPerfCounter('plan_rebuild_skipped_total', 2);
    incPerfCounter('plan_rebuild_total', 1);
    vi.advanceTimersByTime(1000);

    const payload = logStructured.mock.calls[1][0] as { summary?: { rebuildSkipRate?: number } };
    expect(payload.summary?.rebuildSkipRate).toBe(0.5);

    stop();
  });

  it('skips logging when disabled', () => {
    const logStructured = vi.fn();
    const stop = startPerfLogger({
      isEnabled: () => false,
      logStructured,
      intervalMs: 1000,
    });

    vi.advanceTimersByTime(3000);
    expect(logStructured).not.toHaveBeenCalled();

    stop();
  });

  it('starts and stops cpu spike monitor when configured', () => {
    const logStructured = vi.fn();
    const logCpuSpike = vi.fn();
    const stopCpuMonitor = vi.fn();
    startCpuSpikeMonitorMock.mockReturnValueOnce(stopCpuMonitor);

    const stop = startPerfLogger({
      isEnabled: () => true,
      logStructured,
      logCpuSpike,
      intervalMs: 1000,
    });

    expect(startCpuSpikeMonitorMock).toHaveBeenCalledTimes(1);
    expect(startCpuSpikeMonitorMock.mock.calls[0]?.[0]).toEqual(expect.objectContaining({
      isEnabled: expect.any(Function),
    }));

    stop();

    expect(stopCpuMonitor).toHaveBeenCalledTimes(1);
  });

  it('does not start cpu spike monitor when not configured', () => {
    const logStructured = vi.fn();

    const stop = startPerfLogger({
      isEnabled: () => true,
      logStructured,
      intervalMs: 1000,
    });

    expect(startCpuSpikeMonitorMock).not.toHaveBeenCalled();

    stop();
  });

  it('starts cpu spike monitor only after perf logging becomes enabled', () => {
    const logStructured = vi.fn();
    const logCpuSpike = vi.fn();
    const stopCpuMonitor = vi.fn();
    let enabled = false;
    startCpuSpikeMonitorMock.mockReturnValueOnce(stopCpuMonitor);

    const stop = startPerfLogger({
      isEnabled: () => enabled,
      logStructured,
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
