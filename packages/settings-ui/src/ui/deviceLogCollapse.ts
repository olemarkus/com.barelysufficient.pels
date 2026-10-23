// Collapse consecutive visually-identical activity-log entries into one row
// with an occurrence count — fifteen identical "Idle / Measured: 0.00 kW"
// cards read as a stuck ticker, not a log. Browser-only display grouping,
// shared by device detail and the combined Activity page.
//
// A burst of one device going back and forth (turned off, resuming, running,
// turned off again within minutes) folds the same way, into one row that names
// the states it moved between: a card per change reads as a malfunction, not a
// log.
//
// Entries arrive newest-first (`SettingsUiDeviceLogPayload` is
// most-recent-first), so a run's `firstAtMs` is the LAST element
// seen. The recorder retains only the newest entries, so a run that includes
// the oldest retained entry may have started earlier than the log can show —
// `truncated` marks that run so the caption can avoid asserting a false
// start.
import type { SettingsUiDeviceActivityEntry } from '../../../contracts/src/settingsUiApi';

type CollapsedRun = {
  /** The run's newest entry, rendered in full. */
  entry: SettingsUiDeviceActivityEntry;
  /** Entries the row stands for. */
  occurrenceCount: number;
  firstAtMs: number;
  truncated: boolean;
};

export type CollapsedLogEntry =
  | CollapsedRun & { kind: 'repeat' }
  /**
   * A back-and-forth burst: `switchCount` changes of state between the
   * `stateMsgs` it moved between, oldest first.
   */
  | CollapsedRun & { kind: 'burst'; stateMsgs: string[]; switchCount: number };

/**
 * The widest step a burst may take between two entries. The restore cooldown
 * is five minutes and backs off to ten after instability, so a device that
 * keeps being turned off and resumed steps at most about that far, while one
 * following 15-minute price periods never folds.
 */
const BURST_MAX_GAP_MS = 12 * 60 * 1000;
/** A burst moves between at most these few states: off, resuming and running. */
const BURST_MAX_STATES = 3;
/**
 * Returns to a state already left. One off-and-on-again (running, limited,
 * resuming, running) returns once and is ordinary history; a burst returns
 * again.
 */
const BURST_MIN_RETURNS = 2;

const entrySignature = (entry: SettingsUiDeviceActivityEntry): string => (
  [entry.deviceId, entry.recordingStartedAtMs, entry.stateMsg,
    entry.powerMsg ?? '', entry.usageMsg, entry.statusMsg].join('\u0000')
);

const collapseIdenticalRuns = (entries: SettingsUiDeviceActivityEntry[]): CollapsedLogEntry[] => {
  const collapsed: CollapsedLogEntry[] = [];
  for (const entry of entries) {
    const previous = collapsed[collapsed.length - 1];
    if (previous && entrySignature(previous.entry) === entrySignature(entry)) {
      previous.occurrenceCount += 1;
      previous.firstAtMs = entry.atMs;
      continue;
    }
    collapsed.push({ kind: 'repeat', entry, occurrenceCount: 1, firstAtMs: entry.atMs, truncated: false });
  }
  return collapsed;
};

/** Whether `next` (older) can join `run`: the same device and session, close in time, few states. */
const continuesBurst = (run: readonly CollapsedLogEntry[], next: CollapsedLogEntry): boolean => {
  const first = run[0];
  const previous = run[run.length - 1];
  if (first === undefined || previous === undefined) return false;
  if (next.entry.deviceId !== first.entry.deviceId) return false;
  if (next.entry.recordingStartedAtMs !== first.entry.recordingStartedAtMs) return false;
  if (previous.firstAtMs - next.entry.atMs > BURST_MAX_GAP_MS) return false;
  const states = new Set(run.map((item) => item.entry.stateMsg));
  states.add(next.entry.stateMsg);
  return states.size <= BURST_MAX_STATES;
};

/** The states `run` moved between, oldest first, and how often it returned to one it had left. */
const readBurstStates = (run: readonly CollapsedLogEntry[]): { stateMsgs: string[]; returns: number } => {
  const stateMsgs: string[] = [];
  let returns = 0;
  let current: string | undefined;
  for (let index = run.length - 1; index >= 0; index -= 1) {
    const stateMsg = run[index]?.entry.stateMsg;
    if (stateMsg === undefined || stateMsg === current) continue;
    if (stateMsgs.includes(stateMsg)) returns += 1;
    else stateMsgs.push(stateMsg);
    current = stateMsg;
  }
  return { stateMsgs, returns };
};

const foldBursts = (items: readonly CollapsedLogEntry[]): CollapsedLogEntry[] => {
  const folded: CollapsedLogEntry[] = [];
  let run: CollapsedLogEntry[] = [];
  const flush = (): void => {
    const head = run[0];
    const tail = run[run.length - 1];
    const { stateMsgs, returns } = readBurstStates(run);
    if (head && tail && returns >= BURST_MIN_RETURNS) {
      let occurrenceCount = 0;
      for (const item of run) occurrenceCount += item.occurrenceCount;
      folded.push({
        kind: 'burst',
        entry: head.entry,
        stateMsgs,
        // Every state after the first is one switch into it, and so is every return.
        switchCount: stateMsgs.length - 1 + returns,
        occurrenceCount,
        firstAtMs: tail.firstAtMs,
        truncated: false,
      });
    } else {
      for (const item of run) folded.push(item);
    }
    run = [];
  };
  for (const item of items) {
    if (run.length > 0 && !continuesBurst(run, item)) flush();
    run.push(item);
  }
  flush();
  return folded;
};

export const collapseRepeatedLogEntries = (
  entries: SettingsUiDeviceActivityEntry[],
): CollapsedLogEntry[] => {
  const collapsed = foldBursts(collapseIdenticalRuns(entries));
  // The final run reaches the retention boundary: its true start may predate
  // the kept window.
  const last = collapsed[collapsed.length - 1];
  if (last && last.occurrenceCount > 1) last.truncated = true;
  return collapsed;
};
