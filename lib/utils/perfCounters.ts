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

let state: PerfSnapshot = {
  startedAt: Date.now(),
  counts: {},
  durations: {},
};

type PerfCounterEntry = string | [string, number];

const normalizeDelta = (delta: number): number => {
  const safeDelta = Number.isFinite(delta) ? delta : 0;
  return safeDelta === 0 ? 0 : safeDelta;
};

export const incPerfCounter = (key: string, delta = 1): void => {
  incPerfCounters([[key, delta]]);
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
  if (deltas.size === 0) return;
  const nextDeltaCounts = Object.fromEntries(
    Array.from(deltas.entries()).map(([key, delta]) => [key, (state.counts[key] || 0) + delta]),
  );
  const nextCounts = { ...state.counts, ...nextDeltaCounts };
  state = { ...state, counts: nextCounts };
};

export const addPerfDuration = (key: string, ms: number): void => {
  if (!key) return;
  const safeMs = Number.isFinite(ms) ? Math.max(0, ms) : 0;
  const entry = state.durations[key] || { totalMs: 0, maxMs: 0, count: 0, windowMaxMs: 0 };
  const nextEntry = {
    totalMs: entry.totalMs + safeMs,
    maxMs: Math.max(entry.maxMs, safeMs),
    count: entry.count + 1,
    windowMaxMs: Math.max(entry.windowMaxMs || 0, safeMs),
  };
  state = {
    ...state,
    durations: {
      ...state.durations,
      [key]: nextEntry,
    },
  };
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
  const nextDurations = Object.fromEntries(
    Object.entries(state.durations).map(([key, value]) => [key, { ...value, windowMaxMs: 0 }]),
  );
  state = {
    ...state,
    durations: nextDurations,
  };
  return snapshot;
};
