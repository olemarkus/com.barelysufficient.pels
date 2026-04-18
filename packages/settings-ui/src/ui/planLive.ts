type LivePlanControllerOptions<TPlan> = {
  refreshDebounceMs?: number;
  hasLiveUpdates: (plan: TPlan | null, renderedAtMs: number) => boolean;
  getEarliestCountdownExpiryMs: (plan: TPlan | null, renderedAtMs: number) => number | null;
  isVisible: () => boolean;
  render: (plan: TPlan | null, renderedAtMs: number, nowMs: number) => void;
  update: (plan: TPlan | null, renderedAtMs: number, nowMs: number) => void;
};

type LivePlanController<TPlan> = {
  renderPlan: (plan: TPlan | null) => void;
  setRefreshCallback: (callback: (() => void | Promise<void>) | null) => void;
};

export const createLivePlanController = <TPlan>(
  options: LivePlanControllerOptions<TPlan>,
): LivePlanController<TPlan> => {
  const refreshDebounceMs = options.refreshDebounceMs ?? 2000;
  let basePlan: TPlan | null = null;
  let renderedAtMs = 0;
  let interval: ReturnType<typeof setInterval> | null = null;
  let refreshTimeout: ReturnType<typeof setTimeout> | null = null;
  let refreshQueued = false;
  let refreshCallback: (() => void | Promise<void>) | null = null;

  const clearIntervalIfNeeded = () => {
    if (!interval) return;
    clearInterval(interval);
    interval = null;
  };

  const clearRefreshTimeoutIfNeeded = () => {
    if (!refreshTimeout) return;
    clearTimeout(refreshTimeout);
    refreshTimeout = null;
  };

  const runQueuedRefresh = async () => {
    refreshTimeout = null;
    if (!options.isVisible() || !refreshCallback) {
      refreshQueued = false;
      return;
    }
    try {
      await refreshCallback();
    } catch {
      // The callback owns logging; keep the controller best-effort.
    } finally {
      refreshQueued = false;
    }
  };

  const queueRefreshIfNeeded = (nowMs: number) => {
    if (!options.isVisible() || refreshQueued || !refreshCallback) return;
    const earliestExpiryMs = options.getEarliestCountdownExpiryMs(basePlan, renderedAtMs);
    if (earliestExpiryMs === null || nowMs < earliestExpiryMs) return;
    refreshQueued = true;
    clearRefreshTimeoutIfNeeded();
    refreshTimeout = setTimeout(() => {
      void runQueuedRefresh();
    }, refreshDebounceMs);
  };

  const tick = () => {
    if (!basePlan || !options.isVisible()) {
      clearIntervalIfNeeded();
      return;
    }
    const nowMs = Date.now();
    options.update(basePlan, renderedAtMs, nowMs);
    queueRefreshIfNeeded(nowMs);
  };

  const restart = () => {
    clearIntervalIfNeeded();
    clearRefreshTimeoutIfNeeded();
    refreshQueued = false;
    if (!options.hasLiveUpdates(basePlan, renderedAtMs) || !options.isVisible()) return;
    interval = setInterval(() => {
      tick();
    }, 1000);
  };

  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', () => {
      if (!basePlan || !options.isVisible()) return;
      options.update(basePlan, renderedAtMs, Date.now());
      restart();
    });
  }

  return {
    renderPlan: (plan: TPlan | null) => {
      basePlan = plan;
      renderedAtMs = Date.now();
      options.render(plan, renderedAtMs, renderedAtMs);
      restart();
    },
    setRefreshCallback: (callback: (() => void | Promise<void>) | null) => {
      refreshCallback = callback;
    },
  };
};
