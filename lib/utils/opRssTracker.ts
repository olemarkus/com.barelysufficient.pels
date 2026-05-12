/* eslint-disable functional/immutable-data -- Module-local rolling window of RSS-delta samples. */
import { addPerfDuration } from './perfCounters';

type OpRssStats = {
  count: number;
  totalBytes: number;
  maxBytes: number;
};

let window: Record<string, OpRssStats> = {};

const MB = 1024 * 1024;

let rssSupported: boolean | undefined;

/**
 * Returns process RSS in bytes, or null when the platform refuses the read.
 *
 * Why: on some Homey/containerized runtimes `process.memoryUsage()` raises
 * `ENOENT uv_resident_set_memory` because libuv can't read `/proc/self/stat`.
 * Throwing through every instrumentation call site would crash hot paths
 * (plan build, daily budget update, price optimizer apply, ...), so callers
 * treat RSS as best-effort and skip the sample on null.
 */
export const safeRss = (): number | null => {
  if (rssSupported === false) return null;
  try {
    const rss = process.memoryUsage().rss;
    rssSupported = true;
    return rss;
  } catch {
    rssSupported = false;
    return null;
  }
};

const record = (key: string, bytes: number): void => {
  if (!key || !Number.isFinite(bytes)) return;
  const cur = window[key];
  window[key] = cur
    ? {
      count: cur.count + 1,
      totalBytes: cur.totalBytes + bytes,
      maxBytes: Math.max(cur.maxBytes, bytes),
    }
    : { count: 1, totalBytes: bytes, maxBytes: bytes };
};

/**
 * Records a single RSS-delta sample for an operation key. Skips when either
 * sample is null (platform doesn't support the read).
 */
export const recordOpRssDelta = (
  key: string,
  before: number | null,
  after: number | null,
): void => {
  if (before === null || after === null) return;
  record(key, after - before);
};

/**
 * Records both the duration and the RSS delta for an op in one call. Use at
 * the end of an op when both the start time and the starting RSS sample are
 * already in scope.
 */
export const recordOpDuration = (key: string, startMs: number, rssBefore: number | null): void => {
  addPerfDuration(key, Date.now() - startMs);
  recordOpRssDelta(key, rssBefore, safeRss());
};

type OpRssWindowEntry = {
  count: number;
  totalMb: number;
  maxMb: number;
  avgMb: number;
};

export const drainOpRssWindow = (): Record<string, OpRssWindowEntry> => {
  const out: Record<string, OpRssWindowEntry> = {};
  for (const [key, stats] of Object.entries(window)) {
    if (stats.count === 0) continue;
    out[key] = {
      count: stats.count,
      totalMb: Math.round(stats.totalBytes / MB * 100) / 100,
      maxMb: Math.round(stats.maxBytes / MB * 100) / 100,
      avgMb: Math.round((stats.totalBytes / stats.count) / MB * 100) / 100,
    };
  }
  window = {};
  return out;
};

/**
 * Test-only hook. Resets the `rssSupported` probe cache so a test that stubs
 * `process.memoryUsage` can exercise both success and failure branches.
 */
export const __resetRssSupportProbeForTests = (): void => {
  rssSupported = undefined;
};
