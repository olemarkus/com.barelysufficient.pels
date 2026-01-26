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
    incPerfCounter('perf.logging.enabled');

    const stop = startPerfLogger({
      isEnabled: () => true,
      log,
      intervalMs: 1000,
    });

    expect(log).toHaveBeenCalledTimes(1);

    incPerfCounter('perf.logging.enabled');
    jest.advanceTimersByTime(1000);

    expect(log).toHaveBeenCalledTimes(2);
    const payload = log.mock.calls[1][1] as { delta?: { counts?: Record<string, number> } };
    expect(payload.delta?.counts?.['perf.logging.enabled']).toBe(1);

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
