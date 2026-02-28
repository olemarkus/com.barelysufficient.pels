import { getPerfSnapshotAndResetWindow, type PerfSnapshot } from '../utils/perfCounters';
import { startCpuSpikeMonitor } from '../utils/cpuSpikeMonitor';

type PerfDurationEntry = {
  totalMs: number;
  maxMs: number;
  count: number;
  avgMs?: number;
};

type PerfDelta = {
  counts: Record<string, number>;
  durations: Record<string, { totalMs: number; count: number; maxMs: number; avgMs: number }>;
};

type PerfSummary = {
  planRebuilds: number;
  powerSamples: number;
  rebuildSkipRate: number;
  rebuildNoChangeRate: number;
  queueDepthGe2: number;
  queueDepthGe4: number;
  queueWaitAvgMs: number;
  queueWaitMaxMs: number;
  planBuildAvgMs: number;
  planBuildMaxMs: number;
  dailyBudgetAvgMs: number;
  settingsWriteAvgMs: number;
};

const VALUE_COUNT_KEY_PATTERNS: RegExp[] = [
  /^plan_rebuild_requested_total$/,
  /^plan_rebuild_total$/,
  /^plan_rebuild_failed_total$/,
  /^plan_rebuild_skipped_total$/,
  /^plan_rebuild_no_change_total$/,
  /^plan_rebuild_action_signature_changed_total$/,
  /^plan_rebuild_reason_or_state_only_changed_total$/,
  /^plan_rebuild_meta_only_changed_total$/,
  /^plan_rebuild_queue_depth_ge_2_total$/,
  /^plan_rebuild_queue_depth_ge_4_total$/,
  /^plan_rebuild_queue_waited_total$/,
  /^power_sample_total$/,
  /^daily_budget_update_total$/,
  /^settings_set\.device_plan_snapshot/,
  /^settings_set\.pels_status/,
  /^device_action_total$/,
  /^device_action\.capability\.(onoff|target_temperature)$/,
];

const VALUE_DURATION_KEYS = new Set([
  'plan_rebuild_ms',
  'plan_rebuild_queue_wait_ms',
  'plan_rebuild_build_ms',
  'plan_rebuild_change_ms',
  'plan_rebuild_snapshot_ms',
  'plan_rebuild_snapshot_write_ms',
  'plan_rebuild_status_ms',
  'plan_rebuild_status_write_ms',
  'plan_rebuild_apply_ms',
  'plan_build_ms',
  'power_sample_ms',
  'daily_budget_update_ms',
  'settings_write_ms',
  'device_fetch_ms',
  'device_refresh_ms',
]);

const buildPerfDelta = (current: PerfSnapshot, previous?: PerfSnapshot | null): PerfDelta => {
  if (!previous) return { counts: {}, durations: {} };
  const countsDelta = Object.keys(current.counts).reduce<Record<string, number>>((acc, key) => {
    const delta = (current.counts[key] || 0) - (previous.counts[key] || 0);
    if (delta === 0) return acc;
    return { ...acc, [key]: delta };
  }, {});
  const durationsDelta = Object.keys(current.durations).reduce<Record<string, { totalMs: number; count: number; maxMs: number; avgMs: number }>>((acc, key) => {
    const currentEntry = current.durations[key];
    const previousEntry = previous.durations[key] || { totalMs: 0, count: 0, maxMs: 0 };
    const deltaTotalMs = currentEntry.totalMs - previousEntry.totalMs;
    const deltaCount = currentEntry.count - previousEntry.count;
    if (deltaTotalMs === 0 && deltaCount === 0) return acc;
    const avgMs = deltaCount > 0 ? deltaTotalMs / deltaCount : 0;
    const windowMaxMs = typeof currentEntry.windowMaxMs === 'number'
      ? currentEntry.windowMaxMs
      : currentEntry.maxMs;
    return {
      ...acc,
      [key]: {
        totalMs: deltaTotalMs,
        count: deltaCount,
        maxMs: windowMaxMs,
        avgMs,
      },
    };
  }, {});
  return { counts: countsDelta, durations: durationsDelta };
};

const formatDurations = (durations: Record<string, PerfDurationEntry>, useProvidedAvg = false): string[] => (
  Object.entries(durations).map(([key, value]) => {
    let avgMs = 0;
    if (useProvidedAvg && typeof value.avgMs === 'number' && Number.isFinite(value.avgMs)) {
      avgMs = value.avgMs;
    } else if (value.count > 0) {
      avgMs = value.totalMs / value.count;
    }
    return `${key}: count=${value.count} totalMs=${value.totalMs.toFixed(1)} avgMs=${avgMs.toFixed(1)} maxMs=${value.maxMs.toFixed(1)}`;
  })
);

const isValuableCountKey = (key: string): boolean => VALUE_COUNT_KEY_PATTERNS.some((pattern) => pattern.test(key));

const filterDeltaCounts = (counts: PerfDelta['counts']): PerfDelta['counts'] => (
  Object.fromEntries(
    Object.entries(counts).filter(([key]) => isValuableCountKey(key)),
  )
);

const filterDeltaDurations = (durations: PerfDelta['durations']): PerfDelta['durations'] => (
  Object.fromEntries(
    Object.entries(durations).filter(([key]) => VALUE_DURATION_KEYS.has(key)),
  )
);

const roundTo = (value: number, decimals: number): number => {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
};

const getCounter = (counts: Record<string, number>, key: string): number => counts[key] || 0;

const getDuration = (
  durations: PerfDelta['durations'],
  key: string,
): { totalMs: number; count: number; maxMs: number; avgMs: number } => (
  durations[key] || { totalMs: 0, count: 0, maxMs: 0, avgMs: 0 }
);

const buildPerfSummary = (delta: PerfDelta): PerfSummary => {
  const planRebuilds = getCounter(delta.counts, 'plan_rebuild_total');
  const powerSamples = getCounter(delta.counts, 'power_sample_total');
  const skipped = getCounter(delta.counts, 'plan_rebuild_skipped_total');
  const noChange = getCounter(delta.counts, 'plan_rebuild_no_change_total');
  const queueDepthGe2 = getCounter(delta.counts, 'plan_rebuild_queue_depth_ge_2_total');
  const queueDepthGe4 = getCounter(delta.counts, 'plan_rebuild_queue_depth_ge_4_total');

  const queueWait = getDuration(delta.durations, 'plan_rebuild_queue_wait_ms');
  const planBuild = getDuration(delta.durations, 'plan_build_ms');
  const dailyBudget = getDuration(delta.durations, 'daily_budget_update_ms');
  const settingsWrite = getDuration(delta.durations, 'settings_write_ms');

  const rebuildSkipRate = powerSamples > 0 ? skipped / powerSamples : 0;
  const rebuildNoChangeRate = planRebuilds > 0 ? noChange / planRebuilds : 0;

  return {
    planRebuilds,
    powerSamples,
    rebuildSkipRate: roundTo(rebuildSkipRate, 3),
    rebuildNoChangeRate: roundTo(rebuildNoChangeRate, 3),
    queueDepthGe2,
    queueDepthGe4,
    queueWaitAvgMs: roundTo(queueWait.avgMs || 0, 2),
    queueWaitMaxMs: roundTo(queueWait.maxMs || 0, 2),
    planBuildAvgMs: roundTo(planBuild.avgMs || 0, 2),
    planBuildMaxMs: roundTo(planBuild.maxMs || 0, 2),
    dailyBudgetAvgMs: roundTo(dailyBudget.avgMs || 0, 2),
    settingsWriteAvgMs: roundTo(settingsWrite.avgMs || 0, 2),
  };
};

export const startPerfLogger = (params: {
  isEnabled: () => boolean;
  log: (...args: unknown[]) => void;
  logCpuSpike?: (...args: unknown[]) => void;
  intervalMs?: number;
}): (() => void) => {
  const intervalMs = typeof params.intervalMs === 'number' ? params.intervalMs : 30 * 1000;
  let lastSnapshot: PerfSnapshot | null = null;
  let stopCpuMonitor: (() => void) | undefined;
  const syncCpuMonitor = (): void => {
    if (typeof params.logCpuSpike !== 'function') return;
    if (params.isEnabled()) {
      if (!stopCpuMonitor) {
        stopCpuMonitor = startCpuSpikeMonitor({
          log: params.logCpuSpike,
          isEnabled: params.isEnabled,
        });
      }
      return;
    }
    if (stopCpuMonitor) {
      stopCpuMonitor();
      stopCpuMonitor = undefined;
    }
  };
  const logCounters = () => {
    syncCpuMonitor();
    if (!params.isEnabled()) return;
    const snapshot = getPerfSnapshotAndResetWindow();
    const delta = buildPerfDelta(snapshot, lastSnapshot);
    lastSnapshot = snapshot;
    const filteredDeltaCounts = filterDeltaCounts(delta.counts);
    const filteredDeltaDurations = filterDeltaDurations(delta.durations);
    const uptimeSec = Math.round((Date.now() - snapshot.startedAt) / 1000);
    const payload = {
      uptimeSec,
      summary: buildPerfSummary(delta),
      delta: {
        counts: filteredDeltaCounts,
        durations: formatDurations(filteredDeltaDurations, true),
      },
    };
    params.log(`Perf counters ${JSON.stringify(payload)}`);
  };
  logCounters();
  const timer = setInterval(logCounters, intervalMs);
  return () => {
    clearInterval(timer);
    stopCpuMonitor?.();
  };
};
