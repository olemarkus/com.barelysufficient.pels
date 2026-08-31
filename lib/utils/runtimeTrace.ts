type ActiveSpan = {
  name: string;
  startedAtMs: number;
};

type RecentSpan = {
  name: string;
  endedAtMs: number;
  durationMs: number;
};

const MAX_RECENT_SPANS = 512;

let nextSpanId = 1;
const activeSpans = new Map<number, ActiveSpan>();
let nextRecentSpanId = 1;
const recentSpans = new Map<number, RecentSpan>();

const pushRecentSpan = (span: RecentSpan): void => {
  recentSpans.set(nextRecentSpanId, span);
  nextRecentSpanId += 1;
  while (recentSpans.size > MAX_RECENT_SPANS) {
    const oldestKey = recentSpans.keys().next().value;
    if (typeof oldestKey !== 'number') break;
    recentSpans.delete(oldestKey);
  }
};

export const startRuntimeSpan = (name: string): (() => void) => {
  const spanId = nextSpanId;
  nextSpanId += 1;
  const startedAtMs = Date.now();
  activeSpans.set(spanId, { name, startedAtMs });

  let done = false;
  return () => {
    if (done) return;
    done = true;
    const active = activeSpans.get(spanId);
    activeSpans.delete(spanId);
    if (!active) return;
    const endedAtMs = Date.now();
    pushRecentSpan({
      name: active.name,
      endedAtMs,
      durationMs: Math.max(0, endedAtMs - active.startedAtMs),
    });
  };
};

/** An in-flight span: how long it has been running. */
export type ActiveRuntimeSpan = {
  name: string;
  runningMs: number;
};

/** A finished span: how long it took, and how long ago it ended. */
export type RecentRuntimeSpan = {
  name: string;
  durationMs: number;
  endedAgoMs: number;
};

export const listRuntimeSpans = (limit = 8, nowMs = Date.now()): ActiveRuntimeSpan[] => (
  Array.from(activeSpans.values())
    .sort((left, right) => left.startedAtMs - right.startedAtMs)
    .slice(-Math.max(1, limit))
    .map((span) => ({ name: span.name, runningMs: Math.max(0, nowMs - span.startedAtMs) }))
);

export const listRecentRuntimeSpans = (
  limit = 16,
  withinMs = 30_000,
  nowMs = Date.now(),
): RecentRuntimeSpan[] => (
  Array.from(recentSpans.values())
    .filter((span) => (nowMs - span.endedAtMs) <= withinMs)
    .sort((left, right) => right.endedAtMs - left.endedAtMs)
    .slice(0, Math.max(1, limit))
    .map((span) => ({
      name: span.name,
      durationMs: span.durationMs,
      endedAgoMs: Math.max(0, nowMs - span.endedAtMs),
    }))
);
