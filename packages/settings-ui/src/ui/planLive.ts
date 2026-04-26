type LivePlanControllerOptions<TPlan> = {
  hasLiveUpdates: (plan: TPlan | null, renderedAtMs: number, nowMs: number) => boolean;
  isVisible: () => boolean;
  render: (plan: TPlan | null, renderedAtMs: number, nowMs: number) => void;
  update: (plan: TPlan | null, renderedAtMs: number, nowMs: number) => void;
};

type LivePlanController<TPlan> = {
  renderPlan: (plan: TPlan | null) => void;
};

export const createLivePlanController = <TPlan>(
  options: LivePlanControllerOptions<TPlan>,
): LivePlanController<TPlan> => {
  let basePlan: TPlan | null = null;
  let renderedAtMs = 0;
  let interval: ReturnType<typeof setInterval> | null = null;

  const clearIntervalIfNeeded = () => {
    if (!interval) return;
    clearInterval(interval);
    interval = null;
  };

  const tick = () => {
    if (!basePlan || !options.isVisible()) {
      clearIntervalIfNeeded();
      return;
    }
    const nowMs = Date.now();
    options.update(basePlan, renderedAtMs, nowMs);
    if (!options.hasLiveUpdates(basePlan, renderedAtMs, nowMs)) {
      clearIntervalIfNeeded();
    }
  };

  const restart = (nowMs: number) => {
    clearIntervalIfNeeded();
    if (!options.hasLiveUpdates(basePlan, renderedAtMs, nowMs) || !options.isVisible()) return;
    interval = setInterval(() => {
      tick();
    }, 1000);
  };

  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', () => {
      if (!basePlan || !options.isVisible()) return;
      const nowMs = Date.now();
      options.update(basePlan, renderedAtMs, nowMs);
      restart(nowMs);
    });
    document.addEventListener('overview-tab-activated', () => {
      if (!basePlan || !options.isVisible()) return;
      const nowMs = Date.now();
      options.update(basePlan, renderedAtMs, nowMs);
      restart(nowMs);
    });
  }

  return {
    renderPlan: (plan: TPlan | null) => {
      basePlan = plan;
      renderedAtMs = Date.now();
      options.render(plan, renderedAtMs, renderedAtMs);
      restart(renderedAtMs);
    },
  };
};
