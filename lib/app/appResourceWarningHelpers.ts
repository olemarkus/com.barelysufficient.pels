import type Homey from 'homey';
import { getPerfSnapshot } from '../utils/perfCounters';
import { getRecentPlanRebuildTraces, summarizeRecentPlanRebuildTraces } from '../utils/planRebuildTrace';
import { listRecentRuntimeSpans, listRuntimeSpans } from '../utils/runtimeTrace';

type HomeyEmitter = {
  on?: (event: string, listener: (payload: unknown) => void) => void;
  off?: (event: string, listener: (payload: unknown) => void) => void;
  removeListener?: (event: string, listener: (payload: unknown) => void) => void;
};

type StartResourceWarningListenersParams = {
  homey: Homey.App['homey'];
  log: (message: string) => void;
};

const summarizeDuration = (
  durations: ReturnType<typeof getPerfSnapshot>['durations'],
  key: string,
): { count: number; avgMs: number; maxMs: number } => {
  const entry = durations[key];
  if (!entry || typeof entry.count !== 'number' || entry.count <= 0) {
    return { count: 0, avgMs: 0, maxMs: 0 };
  }
  return {
    count: entry.count,
    avgMs: Number((entry.totalMs / entry.count).toFixed(2)),
    maxMs: Number(entry.maxMs.toFixed(2)),
  };
};

const buildWarningPerfPayload = (nowMs: number) => {
  const snapshot = getPerfSnapshot();
  return {
    uptimeSec: Math.round((nowMs - snapshot.startedAt) / 1000),
    counts: {
      planRebuildRequested: snapshot.counts.plan_rebuild_requested_total || 0,
      planRebuild: snapshot.counts.plan_rebuild_total || 0,
      planRebuildFailed: snapshot.counts.plan_rebuild_failed_total || 0,
      dailyBudgetUpdate: snapshot.counts.daily_budget_update_total || 0,
      powerSample: snapshot.counts.power_sample_total || 0,
    },
    durations: {
      planBuild: summarizeDuration(snapshot.durations, 'plan_build_ms'),
      planRebuild: summarizeDuration(snapshot.durations, 'plan_rebuild_ms'),
      planRebuildBuild: summarizeDuration(snapshot.durations, 'plan_rebuild_build_ms'),
      planRebuildChange: summarizeDuration(snapshot.durations, 'plan_rebuild_change_ms'),
      planRebuildSnapshot: summarizeDuration(snapshot.durations, 'plan_rebuild_snapshot_ms'),
      planRebuildSnapshotWrite: summarizeDuration(snapshot.durations, 'plan_rebuild_snapshot_write_ms'),
      planRebuildStatus: summarizeDuration(snapshot.durations, 'plan_rebuild_status_ms'),
      planRebuildStatusWrite: summarizeDuration(snapshot.durations, 'plan_rebuild_status_write_ms'),
      planRebuildApply: summarizeDuration(snapshot.durations, 'plan_rebuild_apply_ms'),
      deviceRefresh: summarizeDuration(snapshot.durations, 'device_refresh_ms'),
      deviceFetch: summarizeDuration(snapshot.durations, 'device_fetch_ms'),
      dailyBudgetUpdate: summarizeDuration(snapshot.durations, 'daily_budget_update_ms'),
    },
    rebuilds: {
      window: summarizeRecentPlanRebuildTraces(120_000, nowMs),
      recent: getRecentPlanRebuildTraces(6, nowMs),
    },
    active: listRuntimeSpans(8, nowMs),
    recent: listRecentRuntimeSpans(16, 30_000, nowMs),
  };
};

const createWarnLogger = (
  kind: 'cpuwarn' | 'memwarn',
  log: (message: string) => void,
): ((payload: unknown) => void) => (
  (payload: unknown): void => {
    const data = (payload && typeof payload === 'object') ? payload as { count?: unknown; limit?: unknown } : {};
    const count = typeof data.count === 'number' && Number.isFinite(data.count) ? data.count : null;
    const limit = typeof data.limit === 'number' && Number.isFinite(data.limit) ? data.limit : null;
    const countText = count !== null ? count : 'n/a';
    const limitText = limit !== null ? limit : 'n/a';
    log(`[perf] homey ${kind} count=${countText} limit=${limitText}`);
    log(`[perf] homey ${kind} context ${JSON.stringify(buildWarningPerfPayload(Date.now()))}`);
  }
);

export const startResourceWarningListeners = (
  params: StartResourceWarningListenersParams,
): (() => void) | undefined => {
  const { homey, log } = params;
  const emitter = homey as unknown as HomeyEmitter;
  if (typeof emitter.on !== 'function') return undefined;

  const cpuwarn = createWarnLogger('cpuwarn', log);
  const memwarn = createWarnLogger('memwarn', log);
  const unload = (): void => {
    log('[perf] homey unload event');
  };

  emitter.on('cpuwarn', cpuwarn);
  emitter.on('memwarn', memwarn);
  emitter.on('unload', unload);

  return () => {
    if (typeof emitter.off === 'function') {
      emitter.off('cpuwarn', cpuwarn);
      emitter.off('memwarn', memwarn);
      emitter.off('unload', unload);
      return;
    }
    if (typeof emitter.removeListener === 'function') {
      emitter.removeListener('cpuwarn', cpuwarn);
      emitter.removeListener('memwarn', memwarn);
      emitter.removeListener('unload', unload);
    }
  };
};
