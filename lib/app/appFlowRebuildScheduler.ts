import { incPerfCounter } from '../utils/perfCounters';

const FLOW_REBUILD_COOLDOWN_MS = 1000;

type FlowRebuildSchedulerParams = {
  rebuildPlanFromCache: (reason?: string) => Promise<void>;
  logDebug: (...args: unknown[]) => void;
  logError: (message: string, error: unknown) => void;
};

export type FlowRebuildScheduler = {
  requestRebuild: (source: string) => void;
  stop: () => void;
};

export function createFlowRebuildScheduler(params: FlowRebuildSchedulerParams): FlowRebuildScheduler {
  const { rebuildPlanFromCache, logDebug, logError } = params;

  let disposed = false;
  let running = false;
  let pendingSource: string | null = null;
  let cooldownTimer: ReturnType<typeof setTimeout> | undefined;
  let lastCompletedAtMs = 0;

  const clearCooldownTimer = (): void => {
    if (!cooldownTimer) return;
    clearTimeout(cooldownTimer);
    cooldownTimer = undefined;
  };

  const runRebuild = (source: string): void => {
    if (disposed) return;
    running = true;
    const reason = `flow_card:${source}`;
    logDebug(`Flow rebuild scheduler: running ${reason}`);
    void rebuildPlanFromCache(reason)
      .catch((error) => {
        logError(`Flow rebuild scheduler failed for ${reason}`, error);
      })
      .finally(() => {
        running = false;
        lastCompletedAtMs = Date.now();
        if (disposed) return;
        if (!pendingSource) return;
        const waitMs = Math.max(0, (lastCompletedAtMs + FLOW_REBUILD_COOLDOWN_MS) - Date.now());
        cooldownTimer = setTimeout(() => {
          cooldownTimer = undefined;
          const nextSource = pendingSource;
          pendingSource = null;
          if (!nextSource) return;
          logDebug(`Flow rebuild scheduler: running trailing rebuild for flow_card:${nextSource}`);
          runRebuild(nextSource);
        }, waitMs);
      });
  };

  return {
    requestRebuild: (source: string): void => {
      if (disposed) return;

      const trimmedSource = source.trim();
      const resolvedSource = trimmedSource.length > 0 ? trimmedSource : 'unspecified';
      if (!running && !cooldownTimer && Date.now() >= (lastCompletedAtMs + FLOW_REBUILD_COOLDOWN_MS)) {
        runRebuild(resolvedSource);
        return;
      }

      incPerfCounter('plan_rebuild_requested.flow_coalesced_total');
      if (pendingSource && pendingSource !== resolvedSource) {
        incPerfCounter('plan_rebuild_requested.flow_pending_source_replaced_total');
        logDebug(
          `Flow rebuild scheduler: replacing pending source ${pendingSource} with ${resolvedSource}`,
        );
      } else {
        logDebug(`Flow rebuild scheduler: coalescing flow rebuild source ${resolvedSource}`);
      }
      pendingSource = resolvedSource;

      if (running || cooldownTimer) return;

      const waitMs = Math.max(0, (lastCompletedAtMs + FLOW_REBUILD_COOLDOWN_MS) - Date.now());
      cooldownTimer = setTimeout(() => {
        cooldownTimer = undefined;
        const nextSource = pendingSource;
        pendingSource = null;
        if (!nextSource) return;
        logDebug(`Flow rebuild scheduler: running delayed rebuild for flow_card:${nextSource}`);
        runRebuild(nextSource);
      }, waitMs);
    },
    stop: (): void => {
      disposed = true;
      pendingSource = null;
      clearCooldownTimer();
    },
  };
}
