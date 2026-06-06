import fs from 'node:fs';
import { getPerfSnapshotAndResetWindow, type PerfSnapshot } from '../utils/perfCounters';
import { startCpuSpikeMonitor } from '../utils/cpuSpikeMonitor';
import { resolveMemoryMb } from '../diagnostics/resourceWarnings';
import { drainGcWindow, startGcObserver } from '../diagnostics/gcObserver';
import { drainOpRssWindow } from '../utils/opRssTracker';
import { resolveSmapsDetail, resolveSmapsSummary } from '../diagnostics/smapsRollup';

const NON_RETRYABLE_FD_PROBE_CODES = new Set(['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM']);

let fdCountSupported: boolean | undefined;
export const resolveFdCount = (): number | null => {
  if (fdCountSupported === false) return null;
  try {
    const entries = fs.readdirSync('/proc/self/fd');
    fdCountSupported = true;
    return entries.length;
  } catch (error) {
    const code = typeof error === 'object' && error !== null && 'code' in error
      ? String((error as { code: unknown }).code)
      : '';
    // Only treat platform-level "not supported" as permanently unsupported.
    // Transient pressure (EMFILE, EAGAIN, EIO) is exactly when this metric
    // is most valuable, so leave the probe armed for the next call.
    if (NON_RETRYABLE_FD_PROBE_CODES.has(code)) fdCountSupported = false;
    return null;
  }
};

/**
 * Test-only hook. Resets the probe cache so a test can exercise both the
 * transient-error retry path and the unsupported-platform short-circuit.
 */
export const __resetFdCountProbeForTests = (): void => {
  fdCountSupported = undefined;
};

type PerfDurationEntry = {
  totalMs: number;
  maxMs: number;
  count: number;
  avgMs?: number;
};

type PerfDelta = {
  counts: Record<string, number>;
  durations: Record<string, PerfDeltaDurationEntry>;
};

type PerfDeltaDurationEntry = {
  totalMs: number;
  count: number;
  maxMs: number;
  avgMs: number;
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


const VALUE_DURATION_KEYS = new Set([
  'plan_rebuild_ms',
  'plan_rebuild_queue_wait_ms',
  'plan_rebuild_build_ms',
  'plan_rebuild_change_ms',
  'plan_rebuild_snapshot_ms',
  'plan_rebuild_status_ms',
  'plan_rebuild_status_write_ms',
  'plan_rebuild_apply_ms',
  'plan_build_ms',
  'power_sample_ms',
  'power_sample_bookkeeping_ms',
  'power_sample_capacity_guard_ms',
  'power_sample_budget_ms',
  'power_sample_rebuild_ms',
  'power_sample_rebuild_wait_ms',
  'power_sample_snapshot_ms',
  'power_sample_state_ms',
  'power_sample_ui_ms',
  'daily_budget_update_ms',
  'daily_budget_compute_ms',
  'daily_budget_persist_ms',
  'settings_write_ms',
  'device_fetch_ms',
  'device_fetch_full_ms',
  'device_fetch_targeted_ms',
  'device_refresh_ms',
  'evaluate_deferred_objectives_ms',
  'price_optimizer_apply_ms',
  // Plan-build sub-stages (recorded by PlanBuilder.trackDuration). Surfaced
  // so the perf log shows which sub-stage dominates plan_build_ms when the
  // total regresses.
  'plan_context_ms',
  'plan_meta_ms',
  'plan_shedding_ms',
  'plan_devices_ms',
  'plan_restore_ms',
  'plan_hold_ms',
  'plan_reasons_ms',
  'plan_finalize_ms',
  'plan_headroom_cooldown_ms',
  // Inside buildInitialPlanDevices, accumulated across the per-device loop.
  'plan_devices_setup_ms',
  'plan_devices_base_ms',
  'plan_devices_offstate_ms',
  // Inside buildPlanSnapshotWithTimings — the un-trackDuration'd regions.
  'plan_deferred_objective_observe_ms',
  'plan_overshoot_ms',
  'plan_observe_diag_ms',
  'plan_emit_deferred_ms',
]);

const buildPerfDelta = (current: PerfSnapshot, previous?: PerfSnapshot | null): PerfDelta => {
  if (!previous) return { counts: {}, durations: {} };
  const countsDelta = Object.keys(current.counts).reduce<Record<string, number>>((acc, key) => {
    const delta = (current.counts[key] || 0) - (previous.counts[key] || 0);
    if (delta === 0) return acc;
    return { ...acc, [key]: delta };
  }, {});
  const durationsDelta = Object.keys(current.durations).reduce<Record<string, PerfDeltaDurationEntry>>((acc, key) => {
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
    return `${key}: count=${value.count} totalMs=${value.totalMs.toFixed(1)} `
      + `avgMs=${avgMs.toFixed(1)} maxMs=${value.maxMs.toFixed(1)}`;
  })
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
  logStructured: (payload: Record<string, unknown>) => void;
  logCpuSpike?: (...args: unknown[]) => void;
  error?: (...args: unknown[]) => void;
  intervalMs?: number;
}): (() => void) => {
  const intervalMs = typeof params.intervalMs === 'number' ? params.intervalMs : 30 * 1000;
  let lastSnapshot: PerfSnapshot | null = null;
  let stopCpuMonitor: (() => void) | undefined;
  let stopGcObserver: (() => void) | undefined;
  const syncObservers = (): void => {
    const enabled = params.isEnabled();
    if (enabled) {
      if (!stopGcObserver) stopGcObserver = startGcObserver();
      if (typeof params.logCpuSpike === 'function' && !stopCpuMonitor) {
        stopCpuMonitor = startCpuSpikeMonitor({
          isEnabled: params.isEnabled,
        });
      }
      return;
    }
    if (stopGcObserver) {
      stopGcObserver();
      stopGcObserver = undefined;
      drainGcWindow();
    }
    if (stopCpuMonitor) {
      stopCpuMonitor();
      stopCpuMonitor = undefined;
    }
  };
  const logCounters = () => {
    syncObservers();
    if (!params.isEnabled()) return;
    const snapshot = getPerfSnapshotAndResetWindow();
    const delta = buildPerfDelta(snapshot, lastSnapshot);
    lastSnapshot = snapshot;
    const filteredDeltaDurations = filterDeltaDurations(delta.durations);
    const uptimeSec = Math.round((Date.now() - snapshot.startedAt) / 1000);
    const payload = {
      uptimeSec,
      memory: resolveMemoryMb(),
      smaps: resolveSmapsSummary(),
      smapsDetail: resolveSmapsDetail(),
      fdCount: resolveFdCount(),
      gc: drainGcWindow(),
      opRss: drainOpRssWindow(),
      summary: buildPerfSummary(delta),
      delta: {
        counts: delta.counts,
        durations: formatDurations(filteredDeltaDurations, true),
      },
    };
    params.logStructured({
      ...payload,
      event: 'perf_counters',
    });
  };
  logCounters();
  const timer = setInterval(logCounters, intervalMs);
  return () => {
    clearInterval(timer);
    stopCpuMonitor?.();
    stopGcObserver?.();
  };
};
