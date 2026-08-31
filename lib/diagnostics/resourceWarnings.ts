import v8 from 'node:v8';
import { resolveSmapsSummary } from '../diagnostics/smapsRollup';
import { getPerfSnapshot } from '../utils/perfCounters';
import { getRecentPlanRebuildTraces, summarizeRecentPlanRebuildTraces } from '../utils/planRebuildTrace';
import { listRecentRuntimeSpans, listRuntimeSpans } from '../utils/runtimeTrace';
import { getLogger } from '../logging/logger';

const resourceWarningLogger = getLogger('perf/resource-warnings');

type HomeyEmitter = {
  on?: (event: string, listener: (payload: unknown) => void) => void;
  off?: (event: string, listener: (payload: unknown) => void) => void;
  removeListener?: (event: string, listener: (payload: unknown) => void) => void;
};

type StartResourceWarningListenersParams = {
  // This listener path consumes only the SDK's event-emitter surface (cpuwarn /
  // memwarn / unload), never settings/clock — so it depends on the local
  // HomeyEmitter shape directly, not the HomeyRuntime port. The full injected
  // instance structurally satisfies it.
  homey: HomeyEmitter;
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

export const resolveMemoryMb = (): Record<string, number | string> => {
  let heap: ReturnType<typeof v8.getHeapStatistics>;
  try {
    heap = v8.getHeapStatistics();
  } catch {
    return { source: 'unavailable' };
  }
  const result: Record<string, number | string> = {
    heapUsedMb: Math.round(heap.used_heap_size / MB * 10) / 10,
    heapTotalMb: Math.round(heap.total_heap_size / MB * 10) / 10,
    heapLimitMb: Math.round(heap.heap_size_limit / MB * 10) / 10,
    externalMb: Math.round(heap.external_memory / MB * 10) / 10,
    mallocMb: Math.round(heap.malloced_memory / MB * 10) / 10,
  };
  // RSS read is best-effort: on Homey runtimes where libuv refuses
  // `/proc/self/stat`, `process.memoryUsage()` throws ENOENT
  // `uv_resident_set_memory`. Keep the heap fields rather than collapsing the
  // whole payload to "unavailable".
  try {
    const mem = process.memoryUsage();
    /* eslint-disable-next-line functional/immutable-data -- Local payload accumulator. */
    Object.assign(result, {
      rssMb: Math.round(mem.rss / MB * 10) / 10,
      arrayBuffersMb: Math.round(mem.arrayBuffers / MB * 10) / 10,
    });
  } catch {
    /* RSS unsupported on this platform; keep heap stats. */
  }
  return result;
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

// One structured record, not the two prose lines this used to write. The first
// of those (`[perf] homey memwarn count=2 limit=5`) was byte-identical across
// all 663 emissions in the sampled production window, and the second wrapped its
// JSON in a prose prefix that made the whole payload unparseable to anything but
// a regex. `.error` keeps them on Homey's error channel — `homeyDestination`
// routes at/above pino's error level there — so the routing is unchanged and only
// the encoding moves.

/**
 * How often the full perf context rides along with a warning.
 *
 * Matched to the window the payload itself summarises
 * (`summarizeRecentPlanRebuildTraces(120_000)`): a second context inside that
 * window is largely a re-dump of the same rows, so the interval is the point
 * below which the extra copy stops telling a reader anything new.
 *
 * It needs an interval at all because the context is the most expensive thing
 * this file does — roughly 4.7 KB of walked rebuild traces and runtime spans,
 * serialised at precisely the moment the runtime has told us memory is tight.
 * Building it per warning is worst-case behaviour: the diagnostic allocates
 * hardest exactly when the condition it reports is at its worst, against a
 * 70 MB heap limit. 299 of the 663 warnings in the sampled window arrived
 * within 60 s of the previous one.
 */
const WARNING_CONTEXT_INTERVAL_MS = 120_000;

/**
 * The context budget, shared by every warning kind.
 *
 * One budget rather than one per kind, because the payload is not per-kind: it
 * summarises the SAME global 120 s window of rebuild traces and runtime spans
 * whichever warning carried it. Two private counters would each treat a
 * combined CPU-and-memory episode as their first and dump ~4.7 KB of
 * substantially the same rows — doubling the allocation in exactly the episode
 * the interval exists to protect.
 *
 * `suppressedContext` is shared for the same reason: it counts warnings of any
 * kind that went without context since the last one carried it, which is the
 * number a reader needs to tell a quiet period from a suppressed burst.
 */
type WarningContextBudget = {
  /** Take the context if it is due, and say how many were skipped waiting. */
  claim(nowMs: number): { withContext: boolean; suppressedContext: number };
};

const createWarningContextBudget = (): WarningContextBudget => {
  let lastContextAtMs: number | null = null;
  let suppressedContextCount = 0;
  return {
    claim(nowMs: number) {
      const withContext = lastContextAtMs === null
        || (nowMs - lastContextAtMs) >= WARNING_CONTEXT_INTERVAL_MS;
      const suppressedContext = suppressedContextCount;
      if (withContext) {
        lastContextAtMs = nowMs;
        suppressedContextCount = 0;
      } else {
        suppressedContextCount += 1;
      }
      return { withContext, suppressedContext };
    },
  };
};

// The WARNING itself is never throttled — every one is still logged, because
// the arrival rate is itself the signal. Only the context is rationed, and a
// record that goes without says how many preceded it, so a reader can tell a
// quiet period from a suppressed burst.
const createWarnLogger = (
  kind: 'cpuwarn' | 'memwarn',
  budget: WarningContextBudget,
): ((payload: unknown) => void) => {
  return (payload: unknown): void => {
    const data = (payload && typeof payload === 'object') ? payload as { count?: unknown; limit?: unknown } : {};
    const count = typeof data.count === 'number' && Number.isFinite(data.count) ? data.count : null;
    const limit = typeof data.limit === 'number' && Number.isFinite(data.limit) ? data.limit : null;
    if (count === 1) return;
    const nowMs = Date.now();
    const { withContext, suppressedContext } = budget.claim(nowMs);
    resourceWarningLogger.error({
      event: `homey_${kind}`,
      kind,
      count,
      limit,
      ...(withContext
        ? { perf: buildWarningPerfPayload(nowMs) }
        : { perfContextSuppressed: true }),
      ...(withContext && suppressedContext > 0 ? { suppressedContextCount: suppressedContext } : {}),
    });
  };
};

export const startResourceWarningListeners = (
  params: StartResourceWarningListenersParams,
): (() => void) | undefined => {
  const { homey: emitter } = params;
  if (!emitter || typeof emitter.on !== 'function') return undefined;

  // One budget for both listeners — see `WarningContextBudget`. Created per
  // start rather than at module scope so a restart begins with a clean window
  // and tests do not inherit one another's.
  const contextBudget = createWarningContextBudget();
  const cpuwarn = createWarnLogger('cpuwarn', contextBudget);
  const memwarn = createWarnLogger('memwarn', contextBudget);
  const unload = (): void => {
    resourceWarningLogger.info({ event: 'homey_unload' });
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
