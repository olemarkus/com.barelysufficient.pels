export type PlanImageDemandState = {
  lastStreamedAtMs?: number;
};

type DebouncedPlanImageRefreshSchedulerParams = {
  debounceMs: number;
  getActiveIndices: () => number[];
  invalidateCache: () => void;
  refreshIndices: (indices: number[]) => Promise<void>;
  onError: (error: unknown) => void;
};

export type DebouncedPlanImageRefreshScheduler = {
  schedule: () => void;
  stop: () => void;
};

export const getActivePlanImageIndices = (
  slots: PlanImageDemandState[],
  params: {
    nowMs?: number;
    activityWindowMs: number;
  },
): number[] => {
  const { nowMs = Date.now(), activityWindowMs } = params;
  const activeIndices: number[] = [];
  for (const [index, slot] of slots.entries()) {
    if (typeof slot.lastStreamedAtMs !== 'number') continue;
    if ((nowMs - slot.lastStreamedAtMs) > activityWindowMs) continue;
    // eslint-disable-next-line functional/immutable-data
    activeIndices.push(index);
  }
  return activeIndices;
};

export const createDebouncedPlanImageRefreshScheduler = (
  params: DebouncedPlanImageRefreshSchedulerParams,
): DebouncedPlanImageRefreshScheduler => {
  const {
    debounceMs,
    getActiveIndices,
    invalidateCache,
    refreshIndices,
    onError,
  } = params;

  let timer: ReturnType<typeof setTimeout> | undefined;
  let running = false;
  let rerunRequested = false;

  const runRefresh = (): void => {
    timer = undefined;
    running = true;
    void Promise.resolve()
      .then(async () => {
        const activeIndices = getActiveIndices();
        if (activeIndices.length === 0) {
          invalidateCache();
          return;
        }
        await refreshIndices(activeIndices);
      })
      .catch((error) => onError(error))
      .finally(() => {
        running = false;
        if (!rerunRequested) return;
        rerunRequested = false;
        schedule();
      });
  };

  const scheduleRun = (): void => {
    if (timer) {
      clearTimeout(timer);
    }
    timer = setTimeout(() => {
      runRefresh();
    }, debounceMs);
  };

  const schedule = (): void => {
    const activeIndices = getActiveIndices();
    if (activeIndices.length === 0) {
      if (timer) {
        clearTimeout(timer);
        timer = undefined;
      }
      invalidateCache();
      return;
    }
    if (running) {
      rerunRequested = true;
      return;
    }
    scheduleRun();
  };

  return {
    schedule,
    stop: (): void => {
      if (timer) {
        clearTimeout(timer);
        timer = undefined;
      }
      running = false;
      rerunRequested = false;
    },
  };
};
