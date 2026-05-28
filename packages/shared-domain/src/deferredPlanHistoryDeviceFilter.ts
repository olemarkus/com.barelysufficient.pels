// Past-tasks device-filter helpers (v2.7.4 PR-19).
//
// The past-tasks list orders entries by `deadlineAtMs` only, so a household
// with one chatty device (e.g. a thermal boiler that runs every night) buries
// every other device's runs in the same scroll. The device-filter chip row
// above the list lets the user collapse the view to a single device, which is
// the question recovering-from-mistake personas almost always ask first
// ("show me just the Connected 300").
//
// Helpers below live in shared-domain so the same strings (and the same
// "unique devices in newest-first order" derivation) can feed structured log
// breadcrumbs alongside the UI (per `feedback_ui_text_shared_with_logs.md`).
// Extracted from `deferredPlanHistory.ts` so that file stays under its
// ESLint max-lines budget; consumers import directly from here.
import type { DeferredObjectivePlanHistoryEntry } from '../../contracts/src/deferredObjectivePlanHistory.js';

// Unique-device summary used by the chip row. Entries are returned in the
// order their device first appears in `entries`; callers MUST already pass
// entries newest-first (matching `resolveDeadlinesHistoryEntries`) so the chip
// order reflects "most recently active first", not insertion order from
// persistence. `deviceName` falls back to `deviceId` when the recorder did not
// capture a name, mirroring the row card's display-name fallback.
export type SmartTaskHistoryFilterDevice = {
  deviceId: string;
  deviceName: string;
};

export const resolveSmartTaskHistoryFilterDevices = (
  entries: ReadonlyArray<Pick<DeferredObjectivePlanHistoryEntry, 'deviceId' | 'deviceName'>>,
): SmartTaskHistoryFilterDevice[] => {
  const seen = new Set<string>();
  const devices: SmartTaskHistoryFilterDevice[] = [];
  for (const entry of entries) {
    if (seen.has(entry.deviceId)) continue;
    seen.add(entry.deviceId);
    devices.push({
      deviceId: entry.deviceId,
      deviceName: entry.deviceName ?? entry.deviceId,
    });
  }
  return devices;
};

// Filter helper — pure list narrowing so the view layer never branches on
// `deviceId === null` to mean "All". Passing `null` (or an unknown id) returns
// the input unchanged so a stale persisted filter that points at a removed
// device gracefully collapses to the "All" view rather than rendering an empty
// archive that hides every run.
export const filterPlanHistoryByDevice = <T extends Pick<DeferredObjectivePlanHistoryEntry, 'deviceId'>>(
  entries: ReadonlyArray<T>,
  deviceId: string | null,
): T[] => {
  if (deviceId === null) return entries.slice();
  const filtered = entries.filter((entry) => entry.deviceId === deviceId);
  // Stale filter target (device no longer present in history). Collapse to the
  // unfiltered list — the chip row will likewise drop the now-invalid chip on
  // the next render so state self-heals. Without this guard a deleted device's
  // persisted filter would leave the user staring at an "empty" archive
  // forever, even though entries exist for other devices.
  if (filtered.length === 0) return entries.slice();
  return filtered;
};

// Chip-row copy. Kept here so the same strings can appear in runtime log
// breadcrumbs that mention which device the user filtered to.
export const SMART_TASK_HISTORY_FILTER_ALL_LABEL = 'All';
export const SMART_TASK_HISTORY_FILTER_GROUP_LABEL = 'Filter past tasks by device';

// Muted "No past runs for X" copy for the active-filter empty state. Reuses
// the same trim-then-fallback shape that the row cards apply to device names
// so a trailing-whitespace device name never leaks into the message.
export const formatSmartTaskHistoryDeviceFilterEmpty = (deviceName: string): string => {
  const trimmed = deviceName.trim();
  if (trimmed.length === 0) return 'No past runs for this device.';
  return `No past runs for ${trimmed}.`;
};
