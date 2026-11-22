import { scheduleInstant } from './scheduleTime';

// Results stored by earlier versions read "Skipped: …" and "Could not run: …", and the
// two successes had no full stop. A row reads them in today's wording, so its
// "Last: … · …" line keeps one colon.
const LEGACY_RESULT_PREFIXES: ReadonlyArray<readonly [string, string]> = [
  ['Skipped: ', 'Skipped because '], ['Could not run: ', 'Could not run. '],
];
const LEGACY_RESULTS: Readonly<Record<string, string>> = {
  'Mode changed': 'Mode changed.', 'Smart task created': 'Smart task created.',
  "Waiting for the device's current Smart task to end.": 'Skipped because this device already has a Smart task.',
};
export const currentResultWording = (result: string): string => {
  const legacy = LEGACY_RESULTS[result];
  if (legacy) return legacy;
  const prefix = LEGACY_RESULT_PREFIXES.find(([old]) => result.startsWith(old));
  return prefix ? `${prefix[1]}${result.slice(prefix[0].length)}` : result;
};

export const formatScheduleTime = (atMs: number, timeZone: string): string => new Intl.DateTimeFormat('en-GB', {
  timeZone, weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
}).format(new Date(atMs));

export const occurrenceLabel = (localOccurrence: string, timeZone: string): string => {
  const [date, at] = localOccurrence.split('|');
  const atMs = date && at ? scheduleInstant(date, at, timeZone) : undefined;
  return atMs === undefined ? '' : formatScheduleTime(atMs, timeZone);
};
