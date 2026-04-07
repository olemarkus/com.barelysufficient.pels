import v8 from 'node:v8';
import type Homey from 'homey';
import { resolveSmapsSummary } from './smapsRollup';
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
  error: (...args: unknown[]) => void;
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

const MB = 1024 * 1024;

const resolveMemoryMb = (): Record<string, number | string> => {
  try {
    const heap = v8.getHeapStatistics();
    return {
      heapUsedMb: Math.round(heap.used_heap_size / MB * 10) / 10,
      heapTotalMb: Math.round(heap.total_heap_size / MB * 10) / 10,
      heapLimitMb: Math.round(heap.heap_size_limit / MB * 10) / 10,
      externalMb: Math.round(heap.external_memory / MB * 10) / 10,
      mallocMb: Math.round(heap.malloced_memory / MB * 10) / 10,
    };
  } catch {
    return { source: 'unavailable' };
  }
};

const resolveHeapSpaces = (): Record<string, string> => {
  try {
    return Object.fromEntries(
      v8.getHeapSpaceStatistics()
        .filter((s) => s.space_used_size > 0)
        .map((s) => [s.space_name, `${Math.round(s.space_used_size / 1024)}KB/${Math.round(s.space_size / 1024)}KB`]),
    );
  } catch {
    return {};
  }
};

const buildWarningPerfPayload = (nowMs: number) => {
  const snapshot = getPerfSnapshot();
  return {
    memory: resolveMemoryMb(),
    heapSpaces: resolveHeapSpaces(),
    smaps: resolveSmapsSummary(),
    uptimeSec: Math.round((nowMs - snapshot.startedAt) / 1000),
    counts: {
      powerSampleRequested: snapshot.counts.power_sample_requested_total || 0,
      planRebuildRequested: snapshot.counts.plan_rebuild_requested_total || 0,
      planRebuild: snapshot.counts.plan_rebuild_total || 0,
      planRebuildFailed: snapshot.counts.plan_rebuild_failed_total || 0,
      powerSampleRerunRequested: snapshot.counts.power_sample_rerun_requested_total || 0,
      powerSampleRerunCoalesced: snapshot.counts.power_sample_rerun_coalesced_total || 0,
      powerSampleRerunExecuted: snapshot.counts.power_sample_rerun_executed_total || 0,
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
      powerSampleBookkeeping: summarizeDuration(snapshot.durations, 'power_sample_bookkeeping_ms'),
      powerSampleCapacityGuard: summarizeDuration(snapshot.durations, 'power_sample_capacity_guard_ms'),
      powerSampleBudget: summarizeDuration(snapshot.durations, 'power_sample_budget_ms'),
      powerSampleRebuild: summarizeDuration(snapshot.durations, 'power_sample_rebuild_ms'),
      powerSampleRebuildWait: summarizeDuration(snapshot.durations, 'power_sample_rebuild_wait_ms'),
      powerSampleSnapshot: summarizeDuration(snapshot.durations, 'power_sample_snapshot_ms'),
      powerSampleState: summarizeDuration(snapshot.durations, 'power_sample_state_ms'),
      powerSampleUi: summarizeDuration(snapshot.durations, 'power_sample_ui_ms'),
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
  error: (...args: unknown[]) => void,
): ((payload: unknown) => void) => (
  (payload: unknown): void => {
    const data = (payload && typeof payload === 'object') ? payload as { count?: unknown; limit?: unknown } : {};
    const count = typeof data.count === 'number' && Number.isFinite(data.count) ? data.count : null;
    const limit = typeof data.limit === 'number' && Number.isFinite(data.limit) ? data.limit : null;
    if (count === 1) return;
    const countText = count !== null ? count : 'n/a';
    const limitText = limit !== null ? limit : 'n/a';
    const summary = `[perf] homey ${kind} count=${countText} limit=${limitText}`;
    const context = `[perf] homey ${kind} context ${JSON.stringify(buildWarningPerfPayload(Date.now()))}`;
    error(summary);
    error(context);
  }
);

export const startResourceWarningListeners = (
  params: StartResourceWarningListenersParams,
): (() => void) | undefined => {
  const { homey, log, error } = params;
  const emitter = homey as unknown as HomeyEmitter;
  if (typeof emitter.on !== 'function') return undefined;

  const cpuwarn = createWarnLogger('cpuwarn', error);
  const memwarn = createWarnLogger('memwarn', error);
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
