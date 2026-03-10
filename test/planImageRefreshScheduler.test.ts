import {
  createDebouncedPlanImageRefreshScheduler,
  getActivePlanImageIndices,
} from '../drivers/pels_insights/planImageRefreshScheduler';

const flushMicrotasks = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

describe('planImageRefreshScheduler', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('returns only plan image slots with recent demand', () => {
    const nowMs = 10_000;

    expect(getActivePlanImageIndices([
      { lastStreamedAtMs: nowMs - 100 },
      { lastStreamedAtMs: nowMs - 30_001 },
      {},
      { lastStreamedAtMs: nowMs },
    ], {
      nowMs,
      activityWindowMs: 30_000,
    })).toEqual([0, 3]);
  });

  it('debounces repeated refresh requests and only refreshes active slots', async () => {
    jest.useFakeTimers();
    const refreshIndices = jest.fn().mockResolvedValue(undefined);
    const invalidateCache = jest.fn();
    const scheduler = createDebouncedPlanImageRefreshScheduler({
      debounceMs: 500,
      getActiveIndices: () => [0],
      invalidateCache,
      refreshIndices,
      onError: jest.fn(),
    });

    scheduler.schedule();
    scheduler.schedule();
    scheduler.schedule();

    await jest.advanceTimersByTimeAsync(499);
    await flushMicrotasks();
    expect(refreshIndices).not.toHaveBeenCalled();

    await jest.advanceTimersByTimeAsync(1);
    await flushMicrotasks();

    expect(refreshIndices).toHaveBeenCalledTimes(1);
    expect(refreshIndices).toHaveBeenCalledWith([0]);
    expect(invalidateCache).not.toHaveBeenCalled();
  });

  it('resets the image refresh debounce window when settings bursts continue', async () => {
    jest.useFakeTimers();
    const refreshIndices = jest.fn().mockResolvedValue(undefined);
    const scheduler = createDebouncedPlanImageRefreshScheduler({
      debounceMs: 500,
      getActiveIndices: () => [0],
      invalidateCache: jest.fn(),
      refreshIndices,
      onError: jest.fn(),
    });

    scheduler.schedule();
    await jest.advanceTimersByTimeAsync(300);
    await flushMicrotasks();

    scheduler.schedule();

    await jest.advanceTimersByTimeAsync(199);
    await flushMicrotasks();
    expect(refreshIndices).not.toHaveBeenCalled();

    await jest.advanceTimersByTimeAsync(1);
    await flushMicrotasks();
    expect(refreshIndices).not.toHaveBeenCalled();

    await jest.advanceTimersByTimeAsync(300);
    await flushMicrotasks();
    expect(refreshIndices).toHaveBeenCalledTimes(1);
    expect(refreshIndices).toHaveBeenCalledWith([0]);
  });

  it('invalidates cache without rendering when no image slot has active demand', () => {
    const refreshIndices = jest.fn().mockResolvedValue(undefined);
    const invalidateCache = jest.fn();
    const scheduler = createDebouncedPlanImageRefreshScheduler({
      debounceMs: 500,
      getActiveIndices: () => [],
      invalidateCache,
      refreshIndices,
      onError: jest.fn(),
    });

    scheduler.schedule();

    expect(invalidateCache).toHaveBeenCalledTimes(1);
    expect(refreshIndices).not.toHaveBeenCalled();
  });
});
