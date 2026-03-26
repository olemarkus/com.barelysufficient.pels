export type DebouncedSyncSchedulerParams = {
  debounceMs: number;
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
    rerunAfterRun = 'debounce',
    run,
    onError,
  } = params;

  let timer: ReturnType<typeof setTimeout> | null = null;
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
    timer = setTimeout(() => {
      executeRun();
    }, debounceMs);
  };

  return {
    schedule: (): Promise<void> => {
      const promise = ensurePendingRun();
      if (running) {
        rerunRequested = true;
        return promise;
      }
      scheduleRun();
      return promise;
    },
    stop: (): void => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      rerunRequested = false;
      finishPendingRun();
    },
  };
};
