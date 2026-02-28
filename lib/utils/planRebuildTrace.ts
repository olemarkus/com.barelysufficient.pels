export type PlanRebuildTrace = {
  reason: string;
  endedAtMs: number;
  queueDepth: number;
  queueWaitMs: number;
  buildMs: number;
  changeMs: number;
  snapshotMs: number;
  snapshotWriteMs: number;
  statusMs: number;
  statusWriteMs: number;
  applyMs: number;
  totalMs: number;
  actionChanged: boolean;
  detailChanged: boolean;
  metaChanged: boolean;
  isDryRun: boolean;
  appliedActions: boolean;
  hadShedding: boolean;
  failed: boolean;
};

export type RecentPlanRebuildTrace = PlanRebuildTrace & {
  ageMs: number;
};

export type PlanRebuildTraceSummary = {
  count: number;
  avgTotalMs: number;
  maxTotalMs: number;
  maxQueueWaitMs: number;
  maxBuildMs: number;
  maxChangeMs: number;
  maxSnapshotMs: number;
  maxSnapshotWriteMs: number;
  maxStatusMs: number;
  maxStatusWriteMs: number;
  maxApplyMs: number;
  actionChangedCount: number;
  appliedActionsCount: number;
  hadSheddingCount: number;
  reasons: Record<string, number>;
};

const MAX_RECENT_REBUILD_TRACES = 64;

let traces: PlanRebuildTrace[] = [];

const roundMs = (value: number): number => (
  Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0
);

const normalizeReason = (reason: string | null | undefined): string => {
  const trimmed = typeof reason === 'string' ? reason.trim() : '';
  return trimmed || 'unspecified';
};

export const recordPlanRebuildTrace = (
  trace: Omit<PlanRebuildTrace, 'endedAtMs'> & { endedAtMs?: number },
): void => {
  traces = [
    ...traces,
    {
      ...trace,
      reason: normalizeReason(trace.reason),
      endedAtMs: typeof trace.endedAtMs === 'number' ? trace.endedAtMs : Date.now(),
      queueDepth: Math.max(0, Math.round(trace.queueDepth)),
      queueWaitMs: roundMs(trace.queueWaitMs),
      buildMs: roundMs(trace.buildMs),
      changeMs: roundMs(trace.changeMs),
      snapshotMs: roundMs(trace.snapshotMs),
      snapshotWriteMs: roundMs(trace.snapshotWriteMs),
      statusMs: roundMs(trace.statusMs),
      statusWriteMs: roundMs(trace.statusWriteMs),
      applyMs: roundMs(trace.applyMs),
      totalMs: roundMs(trace.totalMs),
      actionChanged: trace.actionChanged === true,
      detailChanged: trace.detailChanged === true,
      metaChanged: trace.metaChanged === true,
      isDryRun: trace.isDryRun === true,
      appliedActions: trace.appliedActions === true,
      hadShedding: trace.hadShedding === true,
      failed: trace.failed === true,
    },
  ];
  if (traces.length > MAX_RECENT_REBUILD_TRACES) {
    traces = traces.slice(-MAX_RECENT_REBUILD_TRACES);
  }
};

export const getRecentPlanRebuildTraces = (
  limit = 6,
  nowMs = Date.now(),
): RecentPlanRebuildTrace[] => (
  traces
    .slice(-Math.max(1, limit))
    .reverse()
    .map((trace) => ({
      ...trace,
      ageMs: Math.max(0, nowMs - trace.endedAtMs),
    }))
);

export const summarizeRecentPlanRebuildTraces = (
  withinMs = 120_000,
  nowMs = Date.now(),
): PlanRebuildTraceSummary => {
  const recent = traces.filter((trace) => (nowMs - trace.endedAtMs) <= withinMs);
  if (recent.length === 0) {
    return {
      count: 0,
      avgTotalMs: 0,
      maxTotalMs: 0,
      maxQueueWaitMs: 0,
      maxBuildMs: 0,
      maxChangeMs: 0,
      maxSnapshotMs: 0,
      maxSnapshotWriteMs: 0,
      maxStatusMs: 0,
      maxStatusWriteMs: 0,
      maxApplyMs: 0,
      actionChangedCount: 0,
      appliedActionsCount: 0,
      hadSheddingCount: 0,
      reasons: {},
    };
  }

  let totals = {
    totalMs: 0,
    maxTotalMs: 0,
    maxQueueWaitMs: 0,
    maxBuildMs: 0,
    maxChangeMs: 0,
    maxSnapshotMs: 0,
    maxSnapshotWriteMs: 0,
    maxStatusMs: 0,
    maxStatusWriteMs: 0,
    maxApplyMs: 0,
    actionChangedCount: 0,
    appliedActionsCount: 0,
    hadSheddingCount: 0,
    reasons: {} as Record<string, number>,
  };

  for (const trace of recent) {
    totals = {
      ...totals,
      totalMs: totals.totalMs + trace.totalMs,
      maxTotalMs: Math.max(totals.maxTotalMs, trace.totalMs),
      maxQueueWaitMs: Math.max(totals.maxQueueWaitMs, trace.queueWaitMs),
      maxBuildMs: Math.max(totals.maxBuildMs, trace.buildMs),
      maxChangeMs: Math.max(totals.maxChangeMs, trace.changeMs),
      maxSnapshotMs: Math.max(totals.maxSnapshotMs, trace.snapshotMs),
      maxSnapshotWriteMs: Math.max(totals.maxSnapshotWriteMs, trace.snapshotWriteMs),
      maxStatusMs: Math.max(totals.maxStatusMs, trace.statusMs),
      maxStatusWriteMs: Math.max(totals.maxStatusWriteMs, trace.statusWriteMs),
      maxApplyMs: Math.max(totals.maxApplyMs, trace.applyMs),
      actionChangedCount: totals.actionChangedCount + (trace.actionChanged ? 1 : 0),
      appliedActionsCount: totals.appliedActionsCount + (trace.appliedActions ? 1 : 0),
      hadSheddingCount: totals.hadSheddingCount + (trace.hadShedding ? 1 : 0),
      reasons: {
        ...totals.reasons,
        [trace.reason]: (totals.reasons[trace.reason] || 0) + 1,
      },
    };
  }

  return {
    count: recent.length,
    avgTotalMs: Number((totals.totalMs / recent.length).toFixed(2)),
    maxTotalMs: totals.maxTotalMs,
    maxQueueWaitMs: totals.maxQueueWaitMs,
    maxBuildMs: totals.maxBuildMs,
    maxChangeMs: totals.maxChangeMs,
    maxSnapshotMs: totals.maxSnapshotMs,
    maxSnapshotWriteMs: totals.maxSnapshotWriteMs,
    maxStatusMs: totals.maxStatusMs,
    maxStatusWriteMs: totals.maxStatusWriteMs,
    maxApplyMs: totals.maxApplyMs,
    actionChangedCount: totals.actionChangedCount,
    appliedActionsCount: totals.appliedActionsCount,
    hadSheddingCount: totals.hadSheddingCount,
    reasons: totals.reasons,
  };
};

export const clearPlanRebuildTracesForTests = (): void => {
  traces = [];
};
