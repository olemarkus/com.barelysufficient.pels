import { Fragment, render } from 'preact';
import type { SettingsUiDeviceActivityEntry } from '../../../../contracts/src/settingsUiApi.ts';
import { HOME_SCOPE_ACTIVITY_NOT_RECORDED } from '../homeScopeCopy.ts';
import { chipModifierForTone } from './chipModifier.ts';
import { MdTextButton } from './materialWebJSX.tsx';
import {
  collapseRepeatedLogEntries,
  type CollapsedLogEntry,
} from '../deviceLogCollapse.ts';

export type DeviceLogViewState =
  | { status: 'loading' }
  | { status: 'error' }
  // Honest not-supported state (multi-home locked decision 5): the log is the
  // Main home's history, so a meter-area device needs an explicit scope notice,
  // never an empty list that reads as a quiet device.
  | { status: 'notRecorded' }
  | { status: 'ready'; entries: SettingsUiDeviceActivityEntry[]; persistence: 'stored' | 'pending' };

type DeviceLogViewProps = {
  state: DeviceLogViewState;
  formatTimestamp: (atMs: number) => string;
  showDeviceNames?: boolean;
  reportable?: boolean;
};

const DeviceLogEmpty = ({ message }: { message: string }) => (
  <p class="pels-text-supporting muted device-log__empty">{message}</p>
);

type DeviceLogEntryRowProps = {
  item: CollapsedLogEntry;
  showDeviceNames: boolean;
  reportable: boolean;
  formatTimestamp: (atMs: number) => string;
};

/** `Limited and Running`, `Limited, Resuming and Running`. */
const joinStateLabels = (labels: readonly string[]): string => (
  labels.length <= 2 ? labels.join(' and ') : `${labels.slice(0, -1).join(', ')} and ${labels.at(-1)}`
);

const formatRunCaption = (item: CollapsedLogEntry, formatTimestamp: (atMs: number) => string): string => {
  if (item.kind === 'burst') {
    // The count before the states: a state label can carry its own detail
    // (`Limited · Off`), and a count or time after it would read as part of it.
    const times = `${item.switchCount} times between ${joinStateLabels(item.stateMsgs)}`;
    return item.truncated
      ? `Switched ${times}. The log keeps only recent changes, so this may have started earlier.`
      : `Since ${formatTimestamp(item.firstAtMs)}, switched ${times}`;
  }
  return item.truncated
    ? `Seen ${item.occurrenceCount} times — the log keeps only recent changes, so the run may have started earlier`
    : `Seen ${item.occurrenceCount} times since ${formatTimestamp(item.firstAtMs)}`;
};

const DeviceLogEntryRow = ({ item, formatTimestamp, showDeviceNames, reportable }: DeviceLogEntryRowProps) => {
  const { entry } = item;
  return (
    <li class="device-log__entry">
      {showDeviceNames && <p class="pels-text-card-title device-log__line entity-name">{entry.deviceName}</p>}
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
      {entry.usageMsg && <p class="pels-text-caption muted device-log__line">{entry.usageMsg}</p>}
      {/* A chip-only entry keeps the chip as its headline — an empty body row
          rendered as a broken-looking card. */}
      {entry.statusMsg ? (
        <p class="pels-text-body device-log__line">{entry.statusMsg}</p>
      ) : null}
      {item.occurrenceCount > 1 ? (
        <p class="pels-text-caption muted device-log__line">{formatRunCaption(item, formatTimestamp)}</p>
      ) : null}
      {reportable && <MdTextButton type="button" data-report-device-id={entry.deviceId}
        data-report-home-id="main" data-report-at-ms={entry.atMs}>Report a problem</MdTextButton>}
    </li>
  );
};

export const DeviceLogContent = ({ state, formatTimestamp, showDeviceNames = false, reportable = true }: DeviceLogViewProps) => {
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
    return <DeviceLogEmpty message="No activity recorded yet. Device state changes will appear here and stay available after PELS restarts." />;
  }
  return (
    <>
      {state.persistence === 'pending' && (
        <p class="pels-text-supporting" role="status">Recent activity is waiting to be saved. PELS will retry.</p>
      )}
      <ol class="device-log__list">
        {collapseRepeatedLogEntries(state.entries).map((item, index, items) => (
          <Fragment key={item.entry.id}>
            {(index === 0 || items[index - 1]?.entry.recordingStartedAtMs !== item.entry.recordingStartedAtMs) && (
              <li class="pels-text-caption muted device-log__session">
                PELS started {formatTimestamp(item.entry.recordingStartedAtMs)}
              </li>
            )}
            <DeviceLogEntryRow
              key={item.entry.id}
              item={item}
              formatTimestamp={formatTimestamp}
              showDeviceNames={showDeviceNames}
              reportable={reportable}
            />
          </Fragment>
        ))}
      </ol>
    </>
  );
};

export const renderDeviceLogView = (
  surface: HTMLElement,
  props: DeviceLogViewProps,
): void => {
  render(<DeviceLogContent {...props} />, surface);
};
