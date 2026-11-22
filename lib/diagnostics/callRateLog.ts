import { getLogger } from '../logging/logger';
import { getPerfSnapshot } from '../utils/perfCounters';

const callRateLogger = getLogger('perf/call-rates');

/**
 * The counters this log watches: every Homey REST call by method and path
 * (`homey_api.*`, counted in the transport), the device refreshes by caller
 * (`device_refresh.*`) and the devices each kind of read returns
 * (`device_refresh_read.*`).
 */
const WATCHED_PREFIXES = ['homey_api.', 'device_refresh.', 'device_refresh_read.'] as const;

/** A counter that ran more often than this, per minute over a window, is logged. */
const FREQUENT_PER_MINUTE = 1;
const MAX_LOGGED = 20;

type FrequentCall = { key: string; count: number; perMinute: number };

/**
 * Logs, once per window, every watched counter that ran more than once a minute
 * during it. Info level, so the line reaches diagnostics reports without debug
 * logging: a home with CPU pressure then names the call or caller behind it.
 */
export function createCallRateLog(startedAtMs: number) {
  let windowStartMs = startedAtMs;
  let previous = watchedCounts();
  return {
    onInterval(nowMs: number): void {
      const minutes = (nowMs - windowStartMs) / 60_000;
      const current = watchedCounts();
      const frequent: FrequentCall[] = minutes <= 0 ? [] : [...current].flatMap(([key, value]) => {
        const count = value - (previous.get(key) ?? 0);
        const perMinute = count / minutes;
        return perMinute > FREQUENT_PER_MINUTE ? [{ key, count, perMinute: Math.round(perMinute * 10) / 10 }] : [];
      });
      /* eslint-disable-next-line functional/immutable-data -- Sorts this window's own list. */
      frequent.sort((a, b) => b.count - a.count);
      windowStartMs = nowMs;
      previous = current;
      if (frequent.length === 0) return;
      callRateLogger.info({
        event: 'frequent_calls',
        windowMinutes: Math.round(minutes * 10) / 10,
        thresholdPerMinute: FREQUENT_PER_MINUTE,
        calls: frequent.slice(0, MAX_LOGGED),
        ...(frequent.length > MAX_LOGGED ? { notLogged: frequent.length - MAX_LOGGED } : {}),
      });
    },
  };
}

function watchedCounts(): Map<string, number> {
  const counts = new Map<string, number>();
  for (const [key, value] of Object.entries(getPerfSnapshot().counts)) {
    if (WATCHED_PREFIXES.some((prefix) => key.startsWith(prefix))) counts.set(key, value);
  }
  return counts;
}
