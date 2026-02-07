import { incPerfCounter } from '../lib/utils/perfCounters';
import { startPerfLogger } from '../lib/app/perfLogging';

describe('startPerfLogger', () => {
  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(new Date('2026-01-26T12:00:00Z'));
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
});
