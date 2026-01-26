export type PerfDuration = {
  totalMs: number;
  maxMs: number;
  count: number;
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

export const incPerfCounter = (key: string, delta = 1): void => {
  if (!key) return;
  const safeDelta = Number.isFinite(delta) ? delta : 0;
  if (safeDelta === 0) return;
  const nextCounts = {
    ...state.counts,
    [key]: (state.counts[key] || 0) + safeDelta,
  };
  state = { ...state, counts: nextCounts };
};

export const addPerfDuration = (key: string, ms: number): void => {
  if (!key) return;
  const safeMs = Number.isFinite(ms) ? Math.max(0, ms) : 0;
  const entry = state.durations[key] || { totalMs: 0, maxMs: 0, count: 0 };
  const nextEntry = {
    totalMs: entry.totalMs + safeMs,
    maxMs: Math.max(entry.maxMs, safeMs),
    count: entry.count + 1,
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
