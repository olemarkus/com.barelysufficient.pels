import { isDeepStrictEqual } from 'node:util';
import type { SupportReportLogLine } from '../../packages/contracts/src/supportReport';
import { LOG_TAIL_HOUR_MS } from './logTailStore';

const REPEATED_SUMMARY_EVENTS = new Set([
  'frequent_calls',
  'flow_conflict_detection',
  'periodic_device_health_summary',
]);

/** Fold identical observations within each stream and UTC hour after report filtering. */
export function foldSupportReportLog(lines: readonly SupportReportLogLine[]): SupportReportLogLine[] {
  const folded: SupportReportLogLine[] = [];
  const lastByScope = new Map<string, number>();
  /* eslint-disable functional/immutable-data -- Update this function's own output in one pass. */
  for (const line of lines) {
    const { event, module, component, homeId, deviceId, chargerId } = line.entry;
    if (typeof event !== 'string' || !REPEATED_SUMMARY_EVENTS.has(event)) {
      folded.push(line);
      continue;
    }

    const scope = JSON.stringify([event, module, component, homeId, deviceId, chargerId]);
    const index = lastByScope.get(scope) ?? folded.length;
    const previous = folded[index];
    if (previous && line.level === 'info' && previous.level === 'info'
      && line.atMs >= (previous.repeated?.lastAtMs ?? previous.atMs)
      && Math.floor(previous.atMs / LOG_TAIL_HOUR_MS) === Math.floor(line.atMs / LOG_TAIL_HOUR_MS)
      && isDeepStrictEqual(previous.entry, line.entry)) {
      folded[index] = {
        ...previous,
        repeated: { count: (previous.repeated?.count ?? 1) + 1, lastAtMs: line.atMs },
      };
      continue;
    }
    lastByScope.set(scope, folded.length);
    folded.push(line);
  }
  /* eslint-enable functional/immutable-data */
  return folded;
}
