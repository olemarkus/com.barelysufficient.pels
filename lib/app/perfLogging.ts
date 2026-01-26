import { getPerfSnapshotAndResetWindow, type PerfSnapshot } from '../utils/perfCounters';

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

export const startPerfLogger = (params: {
  isEnabled: () => boolean;
  log: (...args: unknown[]) => void;
  intervalMs?: number;
}): (() => void) => {
  const intervalMs = typeof params.intervalMs === 'number' ? params.intervalMs : 30 * 1000;
  let lastSnapshot: PerfSnapshot | null = null;
  const logCounters = () => {
    if (!params.isEnabled()) return;
    const snapshot = getPerfSnapshotAndResetWindow();
    const delta = buildPerfDelta(snapshot, lastSnapshot);
    lastSnapshot = snapshot;
    const uptimeSec = Math.round((Date.now() - snapshot.startedAt) / 1000);
    const payload = {
      uptimeSec,
      totals: {
        counts: snapshot.counts,
        durations: formatDurations(snapshot.durations),
      },
      delta: {
        counts: delta.counts,
        durations: formatDurations(delta.durations, true),
      },
    };
    params.log(`Perf counters ${JSON.stringify(payload)}`);
  };
  logCounters();
  const timer = setInterval(logCounters, intervalMs);
  return () => clearInterval(timer);
};
