import { startAppServices } from '../lib/app/appLifecycleHelpers';

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
};

const createDeferred = <T>(): Deferred<T> => {
  let resolveRef: (value: T | PromiseLike<T>) => void = () => undefined;
  const promise = new Promise<T>((resolve) => {
    resolveRef = resolve;
  });
  return {
    promise,
    resolve: resolveRef,
  };
};

const flushMicrotasks = async (iterations = 8): Promise<void> => {
  for (let index = 0; index < iterations; index += 1) {
    await Promise.resolve();
  }
};

const buildParams = () => ({
  loadPowerTracker: jest.fn<void, [options?: { skipDailyBudgetUpdate?: boolean }]>(),
  loadPriceOptimizationSettings: jest.fn<void, []>(),
  initOptimizer: jest.fn<void, []>(),
  startHeartbeat: jest.fn<void, []>(),
  updateOverheadToken: jest.fn<Promise<void>, []>(async () => undefined),
  refreshDailyBudgetState: jest.fn<void, []>(),
  refreshTargetDevicesSnapshot: jest.fn<Promise<void>, []>(async () => undefined),
  rebuildPlanFromCache: jest.fn<Promise<void>, []>(async () => undefined),
  setLastNotifiedOperatingMode: jest.fn<void, [string]>(),
  getOperatingMode: jest.fn<string, []>(() => 'Home'),
  registerFlowCards: jest.fn<void, []>(),
  startPeriodicSnapshotRefresh: jest.fn<void, []>(),
  refreshSpotPrices: jest.fn<Promise<void>, []>(async () => undefined),
  refreshGridTariffData: jest.fn<Promise<void>, []>(async () => undefined),
  startPriceRefresh: jest.fn<void, []>(),
  startPriceOptimization: jest.fn<Promise<void>, [boolean?]>(async () => undefined),
  logError: jest.fn<void, [string, Error]>(),
});

describe('startup critical path perf guardrails', () => {
  it('runs baseline startup hooks', async () => {
    const params = buildParams();
    await startAppServices(params);
    await flushMicrotasks();

    expect(params.loadPowerTracker).toHaveBeenCalledTimes(1);
    expect(params.loadPowerTracker).toHaveBeenCalledWith({ skipDailyBudgetUpdate: true });
    expect(params.loadPriceOptimizationSettings).toHaveBeenCalledTimes(1);
    expect(params.initOptimizer).toHaveBeenCalledTimes(1);
    expect(params.startHeartbeat).toHaveBeenCalledTimes(1);
    expect(params.updateOverheadToken).toHaveBeenCalledTimes(1);
    expect(params.refreshDailyBudgetState).toHaveBeenCalledTimes(1);
    expect(params.registerFlowCards).toHaveBeenCalledTimes(1);
    expect(params.startPeriodicSnapshotRefresh).toHaveBeenCalledTimes(1);
    expect(params.startPriceRefresh).toHaveBeenCalledTimes(1);
    expect(params.startPriceOptimization).toHaveBeenCalledTimes(1);
    expect(params.startPriceOptimization).toHaveBeenCalledWith(false);
  });

  it('does not block startup completion on initial snapshot and plan rebuild', async () => {
    const params = buildParams();
    const refreshSnapshotGate = createDeferred<void>();
    const rebuildPlanGate = createDeferred<void>();

    params.refreshTargetDevicesSnapshot.mockImplementation(() => refreshSnapshotGate.promise);
    params.rebuildPlanFromCache.mockImplementation(() => rebuildPlanGate.promise);

    const startupPromise = startAppServices(params);
    let settled = false;
    startupPromise.then(() => {
      settled = true;
    });

    try {
      await flushMicrotasks();
      expect(params.registerFlowCards).toHaveBeenCalledTimes(1);
      expect(params.startPeriodicSnapshotRefresh).toHaveBeenCalledTimes(1);
      expect(params.startPriceRefresh).toHaveBeenCalledTimes(1);
      expect(settled).toBe(true);
    } finally {
      refreshSnapshotGate.resolve(undefined);
      rebuildPlanGate.resolve(undefined);
      await startupPromise;
    }
  });

  it('defers snapshot and plan bootstrap when delay is configured', async () => {
    jest.useFakeTimers();
    const params = buildParams();
    const callOrder: string[] = [];

    params.refreshTargetDevicesSnapshot.mockImplementation(async () => {
      callOrder.push('refresh');
    });
    params.rebuildPlanFromCache.mockImplementation(async () => {
      callOrder.push('rebuild');
    });

    try {
      await startAppServices({
        ...params,
        snapshotPlanBootstrapDelayMs: 100,
      });
      await flushMicrotasks();
      expect(callOrder).toEqual([]);
      expect(params.refreshDailyBudgetState).not.toHaveBeenCalled();

      jest.advanceTimersByTime(99);
      await flushMicrotasks();
      expect(callOrder).toEqual([]);
      expect(params.refreshDailyBudgetState).not.toHaveBeenCalled();

      jest.advanceTimersByTime(1);
      await flushMicrotasks();
      expect(params.refreshDailyBudgetState).toHaveBeenCalledTimes(1);
      expect(callOrder).toEqual(['refresh', 'rebuild']);
    } finally {
      jest.useRealTimers();
    }
  });

  it('schedules overhead token update only once without delay', async () => {
    const params = buildParams();
    await startAppServices(params);
    await flushMicrotasks();
    expect(params.updateOverheadToken).toHaveBeenCalledTimes(1);
  });

  it('captures synchronous throws from background tasks', async () => {
    const params = buildParams();
    const error = new Error('sync boom');
    params.updateOverheadToken.mockImplementation(() => {
      throw error;
    });

    await expect(startAppServices(params)).resolves.toBeUndefined();
    await flushMicrotasks();

    expect(params.logError).toHaveBeenCalledWith('startup_update_overhead_token', error);
  });

  it('does not block startup completion on long-running price pipeline bootstrap', async () => {
    const params = buildParams();
    const refreshSpotGate = createDeferred<void>();
    const refreshTariffGate = createDeferred<void>();
    const optimizeGate = createDeferred<void>();

    params.refreshSpotPrices.mockImplementation(() => refreshSpotGate.promise);
    params.refreshGridTariffData.mockImplementation(() => refreshTariffGate.promise);
    params.startPriceOptimization.mockImplementation(() => optimizeGate.promise);

    const startupPromise = startAppServices(params);
    let settled = false;
    startupPromise.then(() => {
      settled = true;
    });

    try {
      await flushMicrotasks();
      expect(params.registerFlowCards).toHaveBeenCalledTimes(1);
      expect(params.startPeriodicSnapshotRefresh).toHaveBeenCalledTimes(1);
      expect(params.startPriceRefresh).toHaveBeenCalledTimes(1);
      expect(settled).toBe(true);
    } finally {
      refreshSpotGate.resolve(undefined);
      refreshTariffGate.resolve(undefined);
      optimizeGate.resolve(undefined);
      await startupPromise;
    }
  });
});
