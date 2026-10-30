import { render } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import type { SettingsUiDeviceLogPayload } from '../../../../contracts/src/settingsUi/devices.ts';
import { AppBar } from './AppBar.tsx';
import { DeviceLogContent } from './DeviceLogView.tsx';
import { MdFilledSelect, MdOutlinedButton, MdSelectOption } from './materialWebJSX.tsx';

export type ActivityHistoryState =
  | { status: 'loading' }
  | { status: 'error' }
  | { status: 'ready'; payload: SettingsUiDeviceLogPayload };

type ActivityHistoryProps = {
  state: ActivityHistoryState;
  formatTimestamp: (atMs: number) => string;
  onRefresh: () => Promise<void>;
};

const PAGE_SIZE = 50;

type ActivityEntriesProps = {
  payload: SettingsUiDeviceLogPayload;
  formatTimestamp: (atMs: number) => string;
  deviceId: string;
  visibleCount: number;
  onSelect: (deviceId: string) => void;
  onShowOlder: () => void;
};

const ActivityEntries = ({
  payload, formatTimestamp, deviceId, visibleCount, onSelect, onShowOlder,
}: ActivityEntriesProps) => {
  // First occurrence has the most recently recorded name, including removed devices.
  const names = new Map<string, string>();
  for (const entry of payload.entries) {
    if (!names.has(entry.deviceId)) names.set(entry.deviceId, entry.deviceName);
  }
  const entries = payload.entries.filter((entry) => !deviceId || entry.deviceId === deviceId);
  return (
    <div class="activity-history__content">
      <p class="pels-text-supporting muted">
        Up to {payload.retentionDays} days, {payload.maxEntriesPerDevice} entries per device and {payload.maxEntries} in total.
        {' '}Kept when PELS restarts. Device states are recorded again when PELS starts.
      </p>
      <MdFilledSelect
        label="Device"
        value={deviceId}
        onChange={(event) => onSelect((event.currentTarget as HTMLElement & { value: string }).value)}
      >
        <MdSelectOption value=""><div slot="headline">All devices</div></MdSelectOption>
        {[...names].sort((a, b) => a[1].localeCompare(b[1])).map(([id, name]) => (
          <MdSelectOption key={id} value={id}><div slot="headline">{name}</div></MdSelectOption>
        ))}
      </MdFilledSelect>
      <DeviceLogContent
        state={{ status: 'ready', entries: entries.slice(0, visibleCount), persistence: payload.persistence }}
        formatTimestamp={formatTimestamp}
        showDeviceNames
      />
      {entries.length > visibleCount && (
        <MdOutlinedButton onClick={onShowOlder}>
          Show older activity
        </MdOutlinedButton>
      )}
    </div>
  );
};

const ActivityHistoryRoot = ({ state, formatTimestamp, onRefresh }: ActivityHistoryProps) => {
  const [deviceId, setDeviceId] = useState('');
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  useEffect(() => {
    if (state.status !== 'ready' || !deviceId) return;
    if (state.payload.entries.some((entry) => entry.deviceId === deviceId)) return;
    setDeviceId('');
    setVisibleCount(PAGE_SIZE);
  }, [state, deviceId]);
  return (
    <>
      <AppBar
        back={{ target: 'settings', label: 'Back to Settings' }}
        title="Activity"
        lede="Recent device states and reasons in the Main home, newest first."
      />
      <div class="activity-history__actions">
        <MdOutlinedButton onClick={() => { void onRefresh(); }} disabled={state.status === 'loading'}>
          Refresh
        </MdOutlinedButton>
      </div>
      {state.status === 'ready'
        ? <ActivityEntries
            payload={state.payload}
            formatTimestamp={formatTimestamp}
            deviceId={deviceId}
            visibleCount={visibleCount}
            onSelect={(id) => { setDeviceId(id); setVisibleCount(PAGE_SIZE); }}
            onShowOlder={() => setVisibleCount(visibleCount + PAGE_SIZE)}
          />
        : <DeviceLogContent state={state} formatTimestamp={formatTimestamp} />}
    </>
  );
};

export const renderActivityHistoryView = (surface: HTMLElement, props: ActivityHistoryProps): void => {
  render(<ActivityHistoryRoot {...props} />, surface);
};
