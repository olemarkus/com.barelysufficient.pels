export type DebouncedSyncSchedulerParams = {
  debounceMs: number;
  maxWaitMs?: number;
  rerunAfterRun?: 'debounce' | 'immediate';
  run: () => Promise<void>;
  onError: (error: unknown) => void;
};

export type DebouncedSyncScheduler = {
  schedule: () => Promise<void>;
  stop: () => void;
};

export const createDebouncedSyncScheduler = (
  params: DebouncedSyncSchedulerParams,
): DebouncedSyncScheduler => {
  const {
    debounceMs,
    maxWaitMs,
    rerunAfterRun = 'debounce',
    run,
    onError,
  } = params;

  let timer: ReturnType<typeof setTimeout> | null = null;
  let deadline: number | undefined;
  let stopped = false;
  let running = false;
  let rerunRequested = false;
  let pendingRun: Promise<void> | null = null;
  let resolvePendingRun: (() => void) | null = null;

  const ensurePendingRun = (): Promise<void> => {
    if (!pendingRun) {
      pendingRun = new Promise((resolve) => {
        resolvePendingRun = resolve;
      });
    }
    return pendingRun;
  };

  const finishPendingRun = (): void => {
    const resolve = resolvePendingRun;
    resolvePendingRun = null;
    pendingRun = null;
    resolve?.();
  };

  const executeRun = (): void => {
    timer = null;
    deadline = undefined;
    running = true;
    void Promise.resolve()
      .then(() => run())
      .catch((error) => onError(error))
      .finally(() => {
        running = false;
        if (rerunRequested) {
          rerunRequested = false;
          if (rerunAfterRun === 'immediate') {
            executeRun();
            return;
          }
          scheduleRun();
          return;
        }
        finishPendingRun();
      });
  };

  const scheduleRun = (): void => {
    if (timer) {
      clearTimeout(timer);
    }
    const delay = deadline === undefined ? debounceMs : Math.min(debounceMs, Math.max(0, deadline - performance.now()));
    timer = setTimeout(executeRun, delay);
  };

  return {
    schedule: (): Promise<void> => {
      if (stopped) return Promise.resolve();
      // Measure the cap from the first unserved write.
      if (maxWaitMs !== undefined) deadline ??= performance.now() + maxWaitMs;
      const promise = ensurePendingRun();
      if (running) {
        rerunRequested = true;
        return promise;
      }
      scheduleRun();
      return promise;
    },
    stop: (): void => {
      stopped = true;
      deadline = undefined;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      rerunRequested = false;
      finishPendingRun();
    },
  };
};
