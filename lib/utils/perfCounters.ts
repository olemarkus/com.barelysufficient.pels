export type PerfDuration = {
  totalMs: number;
  maxMs: number;
  count: number;
  windowMaxMs?: number;
};

export type PerfSnapshot = {
  startedAt: number;
  counts: Record<string, number>;
  durations: Record<string, PerfDuration>;
};

// Only this module owns live counters. Readers receive detached snapshots.
/* eslint-disable functional/immutable-data -- Mutate privately owned counters; copy at the export boundary. */
const state: PerfSnapshot = {
  startedAt: Date.now(),
  // Metric names must not resolve to inherited properties on the live tables.
  counts: Object.create(null) as Record<string, number>,
  durations: Object.create(null) as Record<string, PerfDuration>,
};

type PerfCounterEntry = string | [string, number];

const normalizeDelta = (delta: number): number => {
  const safeDelta = Number.isFinite(delta) ? delta : 0;
  return safeDelta === 0 ? 0 : safeDelta;
};

export const incPerfCounter = (key: string, delta = 1): void => {
  if (!key) return;
  const safeDelta = normalizeDelta(delta);
  if (safeDelta === 0) return;
  state.counts[key] = (state.counts[key] || 0) + safeDelta;
};

export const incPerfCounters = (entries: PerfCounterEntry[]): void => {
  if (!Array.isArray(entries) || entries.length === 0) return;
  const deltas = new Map<string, number>();
  for (const entry of entries) {
    const [key, delta] = typeof entry === 'string' ? [entry, 1] : entry;
    if (!key) continue;
    const safeDelta = normalizeDelta(delta);
    if (safeDelta === 0) continue;
    const existing = deltas.get(key) || 0;
    deltas.set(key, existing + safeDelta);
  }
  for (const [key, delta] of deltas) {
    state.counts[key] = (state.counts[key] || 0) + delta;
  }
};

export const addPerfDuration = (key: string, ms: number): void => {
  if (!key) return;
  const safeMs = Number.isFinite(ms) ? Math.max(0, ms) : 0;
  const entry = state.durations[key] || { totalMs: 0, maxMs: 0, count: 0, windowMaxMs: 0 };
  state.durations[key] = entry;
  entry.totalMs += safeMs;
  entry.maxMs = Math.max(entry.maxMs, safeMs);
  entry.count += 1;
  entry.windowMaxMs = Math.max(entry.windowMaxMs || 0, safeMs);
};

export const getPerfSnapshot = (): PerfSnapshot => ({
  startedAt: state.startedAt,
  counts: { ...state.counts },
  durations: Object.fromEntries(
    Object.entries(state.durations).map(([key, value]) => [key, { ...value }]),
  ),
});

export const getPerfSnapshotAndResetWindow = (): PerfSnapshot => {
  const snapshot = getPerfSnapshot();
  for (const duration of Object.values(state.durations)) {
    duration.windowMaxMs = 0;
  }
  return snapshot;
};
