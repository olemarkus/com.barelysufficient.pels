import { runStartupStep, startAppServices } from '../lib/app/appLifecycleHelpers';

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

const buildContext = () => {
  const startupLogger = { error: vi.fn() };
  const loadPowerTracker = vi.fn<(options?: { skipDailyBudgetUpdate?: boolean }) => void>();
  const loadPriceOptimizationSettings = vi.fn<() => void>();
  const initOptimizer = vi.fn<() => void>();
  const startHeartbeat = vi.fn<() => void>();
  const updateOverheadToken = vi.fn<() => Promise<void>>(async () => undefined);
  const updateDailyBudgetState = vi.fn<() => void>();
  const refreshTargetDevicesSnapshot = vi.fn<(
    options?: { fast?: boolean; targeted?: boolean; recordHomeyEnergySample?: boolean },
  ) => Promise<void>>(async () => undefined);
  const rebuildPlanFromCache = vi.fn<(reason?: string) => Promise<void>>(async () => undefined);
  const registerFlowCards = vi.fn<() => void>();
  const startPeriodicSnapshotRefresh = vi.fn<() => void>();
  const startHomeyEnergy = vi.fn<() => void>();
  const refreshSpotPrices = vi.fn<() => Promise<void>>(async () => undefined);
  const refreshGridTariffData = vi.fn<() => Promise<void>>(async () => undefined);
  const startPriceRefresh = vi.fn<() => void>();
  const startPriceOptimization = vi.fn<(arg?: boolean) => Promise<void>>(async () => undefined);

  return {
    startupLogger,
    loadPowerTracker,
    loadPriceOptimizationSettings,
    initOptimizer,
    startHeartbeat,
    updateOverheadToken,
    updateDailyBudgetState,
    refreshTargetDevicesSnapshot,
    rebuildPlanFromCache,
    registerFlowCards,
    startPeriodicSnapshotRefresh,
    startHomeyEnergy,
    refreshSpotPrices,
    refreshGridTariffData,
    startPriceRefresh,
    startPriceOptimization,
    ctx: {
      startupBootstrap: undefined,
      homey: { settings: { get: vi.fn() } },
      operatingMode: 'Home',
      lastNotifiedOperatingMode: 'Away',
      loadPowerTracker,
      loadPriceOptimizationSettings,
      startHeartbeat,
      updateOverheadToken,
      registerFlowCards,
      refreshTargetDevicesSnapshot,
      getStructuredLogger: (component: string) => (component === 'startup' ? startupLogger : undefined),
      snapshotHelpers: {
        startPeriodicSnapshotRefresh,
      },
      homeyEnergyHelpers: {
        start: startHomeyEnergy,
      },
      dailyBudgetService: {
        updateState: updateDailyBudgetState,
      },
      priceCoordinator: {
        initOptimizer,
        refreshSpotPrices,
        refreshGridTariffData,
        startPriceRefresh,
        startPriceOptimization,
      },
      planService: {
        rebuildPlanFromCache,
      },
    } as any,
  };
};

describe('startup critical path perf guardrails', () => {
  it('runs baseline startup hooks', async () => {
    const params = buildContext();
    await startAppServices(params.ctx);
    await flushMicrotasks();

    expect(params.loadPowerTracker).toHaveBeenCalledTimes(1);
    expect(params.loadPowerTracker).toHaveBeenCalledWith({ skipDailyBudgetUpdate: true });
    expect(params.loadPriceOptimizationSettings).toHaveBeenCalledTimes(1);
    expect(params.initOptimizer).toHaveBeenCalledTimes(1);
    expect(params.startHeartbeat).toHaveBeenCalledTimes(1);
    expect(params.updateOverheadToken).toHaveBeenCalledTimes(1);
    expect(params.updateDailyBudgetState).toHaveBeenCalledTimes(1);
    expect(params.registerFlowCards).toHaveBeenCalledTimes(1);
    expect(params.startPeriodicSnapshotRefresh).toHaveBeenCalledTimes(1);
    expect(params.startHomeyEnergy).toHaveBeenCalledTimes(1);
    expect(params.startPriceRefresh).toHaveBeenCalledTimes(1);
    expect(params.startPriceOptimization).toHaveBeenCalledTimes(1);
    expect(params.startPriceOptimization).toHaveBeenCalledWith(false);
  });

  it('does not block startup completion on initial snapshot and plan rebuild', async () => {
    const params = buildContext();
    const refreshSnapshotGate = createDeferred<void>();
    const rebuildPlanGate = createDeferred<void>();

    params.refreshTargetDevicesSnapshot.mockImplementation(() => refreshSnapshotGate.promise);
    params.rebuildPlanFromCache.mockImplementation(() => rebuildPlanGate.promise);

    const startupPromise = startAppServices(params.ctx);
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
      expect(params.rebuildPlanFromCache).toHaveBeenCalledTimes(1);
    }
  });

  it('defers snapshot and plan bootstrap when delay is configured', async () => {
    vi.useFakeTimers();
    const params = buildContext();
    const callOrder: string[] = [];

    params.refreshTargetDevicesSnapshot.mockImplementation(async () => {
      callOrder.push('refresh');
    });
    params.rebuildPlanFromCache.mockImplementation(async () => {
      callOrder.push('rebuild');
    });

    try {
      params.ctx.startupBootstrap = { snapshotPlanBootstrapDelayMs: 100 };
      await startAppServices(params.ctx);
      await flushMicrotasks();
      expect(callOrder).toEqual([]);
      expect(params.updateDailyBudgetState).not.toHaveBeenCalled();

      vi.advanceTimersByTime(99);
      await flushMicrotasks();
      expect(callOrder).toEqual([]);
      expect(params.updateDailyBudgetState).not.toHaveBeenCalled();

      vi.advanceTimersByTime(1);
      await flushMicrotasks();
      expect(params.updateDailyBudgetState).toHaveBeenCalledTimes(1);
      expect(params.refreshTargetDevicesSnapshot).toHaveBeenCalledWith({ fast: true, recordHomeyEnergySample: false });
      expect(callOrder).toEqual(['refresh', 'rebuild']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('schedules overhead token update only once without delay', async () => {
    const params = buildContext();
    await startAppServices(params.ctx);
    await flushMicrotasks();
    expect(params.updateOverheadToken).toHaveBeenCalledTimes(1);
  });

  it('captures synchronous throws from background tasks', async () => {
    const params = buildContext();
    const error = new Error('sync boom');
    params.updateOverheadToken.mockImplementation(() => {
      throw error;
    });

    await expect(startAppServices(params.ctx)).resolves.toBeUndefined();
    await flushMicrotasks();

    expect(params.startupLogger.error).toHaveBeenCalledWith(expect.objectContaining({
      event: 'startup_background_task_failed',
      taskLabel: 'startup_update_overhead_token',
      err: error,
    }));
  });

  it('invokes startup-step failure hooks before rethrowing', async () => {
    const error = new Error('startup boom');
    const onError = vi.fn();

    await expect(runStartupStep('initPriceCoordinator', () => {
      throw error;
    }, onError)).rejects.toBe(error);

    expect(onError).toHaveBeenCalledWith('initPriceCoordinator', error);
  });

  it('normalizes non-Error startup-step failures before logging and rethrowing', async () => {
    const onError = vi.fn();

    const rejection = runStartupStep('initPriceCoordinator', () => {
      throw 'startup boom';
    }, onError).catch((error: unknown) => error);

    const error = await rejection;
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe('startup boom');
    expect(onError).toHaveBeenCalledWith('initPriceCoordinator', error);
  });

  it('does not block startup completion on long-running price pipeline bootstrap', async () => {
    const params = buildContext();
    const refreshSpotGate = createDeferred<void>();
    const refreshTariffGate = createDeferred<void>();
    const optimizeGate = createDeferred<void>();

    params.refreshSpotPrices.mockImplementation(() => refreshSpotGate.promise);
    params.refreshGridTariffData.mockImplementation(() => refreshTariffGate.promise);
    params.startPriceOptimization.mockImplementation(() => optimizeGate.promise);

    const startupPromise = startAppServices(params.ctx);
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
