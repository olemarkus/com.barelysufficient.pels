import { render } from 'preact';
import type { SettingsUiDeviceLogEntry } from '../../../../contracts/src/settingsUiApi.ts';
import { HOME_SCOPE_ACTIVITY_NOT_RECORDED } from '../../../../shared-domain/src/homeScopeCopy.ts';
import { chipModifierForTone } from './chipModifier.ts';

export type DeviceLogViewState =
  | { status: 'loading' }
  | { status: 'error' }
  // Honest not-supported state (multi-home locked decision 5): the log is the
  // Main home's recorder, so for a meter-area device the truthful answer is
  // "not recorded yet", never an empty list that reads as a quiet device.
  | { status: 'notRecorded' }
  | { status: 'ready'; entries: SettingsUiDeviceLogEntry[] };

type DeviceLogViewProps = {
  state: DeviceLogViewState;
  formatTimestamp: (atMs: number) => string;
};

const DeviceLogEmpty = ({ message }: { message: string }) => (
  <p class="pels-text-supporting muted device-log__empty">{message}</p>
);

// Consecutive entries whose visible content is identical (state chip, power,
// usage, status) collapse into one row with a repeat count — fifteen identical
// "Idle / Measured: 0.00 kW" cards read as a stuck ticker, not a log.
type CollapsedLogEntry = {
  entry: SettingsUiDeviceLogEntry;
  repeatCount: number;
  firstAtMs: number;
};

const entrySignature = (entry: SettingsUiDeviceLogEntry): string => (
  [entry.stateMsg, entry.powerMsg ?? '', entry.usageMsg, entry.statusMsg].join('\u0000')
);

export const collapseRepeatedLogEntries = (
  entries: SettingsUiDeviceLogEntry[],
): CollapsedLogEntry[] => {
  const collapsed: CollapsedLogEntry[] = [];
  for (const entry of entries) {
    const previous = collapsed[collapsed.length - 1];
    if (previous && entrySignature(previous.entry) === entrySignature(entry)) {
      previous.repeatCount += 1;
      // Entries arrive newest-first; the run's oldest timestamp is the last
      // one seen, so the caption can say since when it has been repeating.
      previous.firstAtMs = entry.atMs;
      continue;
    }
    collapsed.push({ entry, repeatCount: 1, firstAtMs: entry.atMs });
  }
  return collapsed;
};

const DeviceLogEntryRow = ({
  item,
  formatTimestamp,
}: {
  item: CollapsedLogEntry;
  formatTimestamp: (atMs: number) => string;
}) => {
  const { entry } = item;
  return (
    <li class="device-log__entry">
      <div class="device-log__entry-head">
        <span
          class={`plan-chip plan-chip--${chipModifierForTone(entry.stateTone)}`}
          data-state-tone={entry.stateTone}
        >
          {entry.stateMsg}
        </span>
        <time class="pels-text-caption muted device-log__time">{formatTimestamp(entry.atMs)}</time>
      </div>
      {entry.powerMsg ? (
        <p class="pels-text-caption muted device-log__line">{entry.powerMsg}</p>
      ) : null}
      <p class="pels-text-caption muted device-log__line">{entry.usageMsg}</p>
      {/* A chip-only entry keeps the chip as its headline — an empty body row
          rendered as a broken-looking card. */}
      {entry.statusMsg ? (
        <p class="pels-text-body device-log__line">{entry.statusMsg}</p>
      ) : null}
      {item.repeatCount > 1 ? (
        <p class="pels-text-caption muted device-log__line">
          {`Repeated ${item.repeatCount} times since ${formatTimestamp(item.firstAtMs)}`}
        </p>
      ) : null}
    </li>
  );
};

const DeviceLogRoot = ({ state, formatTimestamp }: DeviceLogViewProps) => {
  if (state.status === 'loading') {
    return <DeviceLogEmpty message="Loading activity…" />;
  }
  if (state.status === 'error') {
    return <DeviceLogEmpty message="Activity log unavailable." />;
  }
  if (state.status === 'notRecorded') {
    return <DeviceLogEmpty message={HOME_SCOPE_ACTIVITY_NOT_RECORDED} />;
  }
  if (state.entries.length === 0) {
    return <DeviceLogEmpty message="No activity recorded yet — the log starts fresh after a restart. Changes appear here as PELS limits or resumes this device." />;
  }
  return (
    <ol class="device-log__list">
      {collapseRepeatedLogEntries(state.entries).map((item) => (
        <DeviceLogEntryRow
          key={`${item.entry.atMs}-${item.entry.stateMsg}`}
          item={item}
          formatTimestamp={formatTimestamp}
        />
      ))}
    </ol>
  );
};

export const renderDeviceLogView = (
  surface: HTMLElement,
  props: DeviceLogViewProps,
): void => {
  render(<DeviceLogRoot {...props} />, surface);
};
