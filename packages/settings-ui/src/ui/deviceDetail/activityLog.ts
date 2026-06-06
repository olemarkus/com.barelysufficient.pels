import type { SettingsUiDeviceLogPayload } from '../../../../contracts/src/settingsUiApi.ts';
import { SETTINGS_UI_DEVICE_LOG_PATH } from '../../../../contracts/src/settingsUiApi.ts';
import {
  deviceDetailActivityLogBody,
  deviceDetailActivityLogDisclosure,
} from '../dom.ts';
import { getApiReadModel, getHomeyTimezone } from '../homey.ts';
import { logSettingsError } from '../logging.ts';
import { renderDeviceLogView } from '../views/DeviceLogView.tsx';

let activityLogRequestSeq = 0;

const getDateTimePart = (partsByType: Record<string, string>, type: string): string => partsByType[type] ?? '00';

// Local-clock timestamp in the Homey's timezone, matching the device-detail
// diagnostics formatting so the two advanced sections read consistently.
const formatActivityTimestamp = (atMs: number): string => {
  if (!Number.isFinite(atMs)) return '';
  const partsByType = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      // `getHomeyTimezone()` can return null; coerce to undefined so the
      // formatter falls back to the runtime default instead of throwing
      // RangeError on a null `timeZone`.
      timeZone: getHomeyTimezone() ?? undefined,
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(new Date(atMs)).map((part) => [part.type, part.value]),
  );
  const date = [getDateTimePart(partsByType, 'month'), getDateTimePart(partsByType, 'day')].join('-');
  const time = [getDateTimePart(partsByType, 'hour'), getDateTimePart(partsByType, 'minute')].join(':');
  return `${date} ${time}`;
};

export const isDeviceDetailActivityLogExpanded = (): boolean => (
  deviceDetailActivityLogDisclosure?.open === true
);

export const resetDeviceDetailActivityLogRequests = (): void => {
  activityLogRequestSeq += 1;
};

export const resetDeviceDetailActivityLogView = (): void => {
  if (deviceDetailActivityLogDisclosure) {
    deviceDetailActivityLogDisclosure.open = false;
  }
  renderState({ status: 'loading' });
};

type ActivityLogState =
  | { status: 'loading' }
  | { status: 'error' }
  | { status: 'ready'; entries: SettingsUiDeviceLogPayload['entriesByDeviceId'][string] };

const renderState = (state: ActivityLogState): void => {
  if (!deviceDetailActivityLogBody) return;
  renderDeviceLogView(deviceDetailActivityLogBody, {
    state,
    formatTimestamp: formatActivityTimestamp,
  });
};

export const showDeviceDetailActivityLogLoading = (): void => {
  renderState({ status: 'loading' });
};

export const refreshDeviceDetailActivityLog = async (params: {
  deviceId: string;
  isCurrentDevice: () => boolean;
  showLoading?: boolean;
}): Promise<void> => {
  const requestSeq = activityLogRequestSeq + 1;
  activityLogRequestSeq = requestSeq;
  if (params.showLoading) {
    showDeviceDetailActivityLogLoading();
  }
  try {
    const payload = await getApiReadModel<SettingsUiDeviceLogPayload>(SETTINGS_UI_DEVICE_LOG_PATH);
    if (!params.isCurrentDevice() || activityLogRequestSeq !== requestSeq) return;
    // Guard a nullish payload / missing map so a malformed response renders an
    // empty log rather than throwing a TypeError.
    const entries = (payload?.entriesByDeviceId ?? {})[params.deviceId] ?? [];
    renderState({ status: 'ready', entries });
  } catch (error) {
    if (!params.isCurrentDevice() || activityLogRequestSeq !== requestSeq) return;
    renderState({ status: 'error' });
    await logSettingsError('Failed to load device activity log', error, 'device detail');
  }
};

// Wire the disclosure's open/close to a load. Takes a getter for the currently
// open device so the module owns the activity-log lifecycle without bloating
// the device-detail index file (which is at its line budget).
export const initDeviceDetailActivityLogToggleHandler = (
  getCurrentDeviceId: () => string | null,
): void => {
  deviceDetailActivityLogDisclosure?.addEventListener('toggle', () => {
    const deviceId = getCurrentDeviceId();
    if (!deviceId) return;
    if (!isDeviceDetailActivityLogExpanded()) {
      resetDeviceDetailActivityLogRequests();
      return;
    }
    showDeviceDetailActivityLogLoading();
    void refreshDeviceDetailActivityLog({
      deviceId,
      isCurrentDevice: () => getCurrentDeviceId() === deviceId && isDeviceDetailActivityLogExpanded(),
    });
  });
};

// Refresh on an external data tick (e.g. `plan-updated`), but only when the
// section is open and still showing the same device.
export const refreshDeviceDetailActivityLogIfExpanded = (
  deviceId: string,
  getCurrentDeviceId: () => string | null,
): void => {
  if (!isDeviceDetailActivityLogExpanded()) return;
  void refreshDeviceDetailActivityLog({
    deviceId,
    isCurrentDevice: () => getCurrentDeviceId() === deviceId && isDeviceDetailActivityLogExpanded(),
  });
};
