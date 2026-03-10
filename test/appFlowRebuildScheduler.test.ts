import { createFlowRebuildScheduler } from '../lib/app/appFlowRebuildScheduler';

const flushMicrotasks = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

describe('createFlowRebuildScheduler', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('runs the first flow rebuild immediately and coalesces bursty trailing requests', async () => {
    jest.useFakeTimers();
    let resolveFirstRebuild: (() => void) | null = null;
    const firstRebuildPromise = new Promise<void>((resolve) => {
      resolveFirstRebuild = resolve;
    });
    const rebuildPlanFromCache = jest.fn()
      .mockImplementationOnce(() => firstRebuildPromise)
      .mockResolvedValue(undefined);
    const scheduler = createFlowRebuildScheduler({
      rebuildPlanFromCache,
      logDebug: jest.fn(),
      logError: jest.fn(),
    });

    scheduler.requestRebuild('daily_budget_action');
    scheduler.requestRebuild('price_action');
    scheduler.requestRebuild('latest_source');

    expect(rebuildPlanFromCache).toHaveBeenCalledTimes(1);
    expect(rebuildPlanFromCache).toHaveBeenCalledWith('flow_card:daily_budget_action');

    resolveFirstRebuild?.();
    await flushMicrotasks();

    expect(rebuildPlanFromCache).toHaveBeenCalledTimes(1);

    await jest.advanceTimersByTimeAsync(999);
    await flushMicrotasks();
    expect(rebuildPlanFromCache).toHaveBeenCalledTimes(1);

    await jest.advanceTimersByTimeAsync(1);
    await flushMicrotasks();

    expect(rebuildPlanFromCache).toHaveBeenCalledTimes(2);
    expect(rebuildPlanFromCache).toHaveBeenLastCalledWith('flow_card:latest_source');
  });

  it('logs rebuild failures without dropping later requests', async () => {
    jest.useFakeTimers();
    const error = new Error('boom');
    const rebuildPlanFromCache = jest.fn()
      .mockRejectedValueOnce(error)
      .mockResolvedValue(undefined);
    const logError = jest.fn();
    const scheduler = createFlowRebuildScheduler({
      rebuildPlanFromCache,
      logDebug: jest.fn(),
      logError,
    });

    scheduler.requestRebuild('failing_source');
    await flushMicrotasks();

    expect(logError).toHaveBeenCalledWith('Flow rebuild scheduler failed for flow_card:failing_source', error);

    scheduler.requestRebuild('recovery_source');
    await jest.advanceTimersByTimeAsync(1000);
    await flushMicrotasks();

    expect(rebuildPlanFromCache).toHaveBeenCalledTimes(2);
    expect(rebuildPlanFromCache).toHaveBeenLastCalledWith('flow_card:recovery_source');
  });
});
