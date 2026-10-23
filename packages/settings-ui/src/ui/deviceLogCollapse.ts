// Collapse consecutive visually-identical activity-log entries into one row
// with an occurrence count — fifteen identical "Idle / Measured: 0.00 kW"
// cards read as a stuck ticker, not a log. Browser-only display grouping,
// shared by device detail and the combined Activity page.
//
// Entries arrive newest-first (`SettingsUiDeviceLogPayload` is
// most-recent-first), so a run's `firstAtMs` is the LAST element
// seen. The recorder retains only the newest entries, so a run that includes
// the oldest retained entry may have started earlier than the log can show —
// `truncated` marks that run so the caption can avoid asserting a false
// start.
import type { SettingsUiDeviceActivityEntry } from '../../../contracts/src/settingsUiApi';

export type CollapsedLogEntry = {
  entry: SettingsUiDeviceActivityEntry;
  occurrenceCount: number;
  firstAtMs: number;
  truncated: boolean;
};

const entrySignature = (entry: SettingsUiDeviceActivityEntry): string => (
  [entry.deviceId, entry.recordingStartedAtMs, entry.stateMsg,
    entry.powerMsg ?? '', entry.usageMsg, entry.statusMsg].join('\u0000')
);

export const collapseRepeatedLogEntries = (
  entries: SettingsUiDeviceActivityEntry[],
): CollapsedLogEntry[] => {
  const collapsed: CollapsedLogEntry[] = [];
  for (const entry of entries) {
    const previous = collapsed[collapsed.length - 1];
    if (previous && entrySignature(previous.entry) === entrySignature(entry)) {
      previous.occurrenceCount += 1;
      previous.firstAtMs = entry.atMs;
      continue;
    }
    collapsed.push({ entry, occurrenceCount: 1, firstAtMs: entry.atMs, truncated: false });
  }
  // The final run reaches the retention boundary: its true start may predate
  // the kept window.
  const last = collapsed[collapsed.length - 1];
  if (last && last.occurrenceCount > 1) last.truncated = true;
  return collapsed;
};
