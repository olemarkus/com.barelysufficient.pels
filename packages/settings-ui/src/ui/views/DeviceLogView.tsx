import { render } from 'preact';
import type { SettingsUiDeviceLogEntry } from '../../../../contracts/src/settingsUiApi.ts';

// Tone token -> chip modifier, mirroring the live device cards
// (`PlanDeviceCards.tsx`) so a logged state line wears the same colour it had
// when it was current. Kept as a small local map rather than imported because
// the cards file is a heavy view module; the mapping is three lines.
const STATE_TONE_CHIP_MODIFIER: Record<string, string> = {
  active: 'good',
  resuming: 'good',
  held: 'limited',
  idle: 'muted',
  neutral: 'muted',
  warning: 'alert',
};

const resolveChipModifier = (tone: string): string => STATE_TONE_CHIP_MODIFIER[tone] ?? 'muted';

export type DeviceLogViewState =
  | { status: 'loading' }
  | { status: 'error' }
  | { status: 'ready'; entries: SettingsUiDeviceLogEntry[] };

type DeviceLogViewProps = {
  state: DeviceLogViewState;
  formatTimestamp: (atMs: number) => string;
};

const DeviceLogEmpty = ({ message }: { message: string }) => (
  <p class="pels-text-supporting muted device-log__empty">{message}</p>
);

const DeviceLogEntryRow = ({
  entry,
  formatTimestamp,
}: {
  entry: SettingsUiDeviceLogEntry;
  formatTimestamp: (atMs: number) => string;
}) => (
  <li class="device-log__entry">
    <div class="device-log__entry-head">
      <span
        class={`plan-chip plan-chip--${resolveChipModifier(entry.stateTone)}`}
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
    <p class="pels-text-body device-log__line">{entry.statusMsg}</p>
  </li>
);

const DeviceLogRoot = ({ state, formatTimestamp }: DeviceLogViewProps) => {
  if (state.status === 'loading') {
    return <DeviceLogEmpty message="Loading activity…" />;
  }
  if (state.status === 'error') {
    return <DeviceLogEmpty message="Activity log unavailable." />;
  }
  if (state.entries.length === 0) {
    return <DeviceLogEmpty message="No activity recorded yet — the log starts fresh after a restart. Changes appear here as PELS limits or resumes this device." />;
  }
  return (
    <ol class="device-log__list">
      {state.entries.map((entry) => (
        <DeviceLogEntryRow
          key={`${entry.atMs}-${entry.stateMsg}`}
          entry={entry}
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
