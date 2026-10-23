import { parseDeviceActivityPayload } from '../activityHistoryPayload.ts';
import { formatActivityTimestamp } from '../activityTimestamp.ts';
import type { DeviceLogViewState } from '../views/DeviceLogView.tsx';
import { SETTINGS_UI_DEVICE_LOG_PATH } from '../../../../contracts/src/settingsUiApi.ts';
import {
  deviceDetailActivityLogBody,
  deviceDetailActivityLogDisclosure,
} from '../dom.ts';
import { isDeviceInMeterArea } from '../homeBadges.ts';
import { getApiReadModel } from '../homey.ts';
import { logSettingsError } from '../logging.ts';
import { renderDeviceLogView } from '../views/DeviceLogView.tsx';

let activityLogRequestSeq = 0;

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

const renderState = (state: DeviceLogViewState): void => {
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
  // Honest not-supported state (multi-home locked decision 5): the payload is
  // the Main home's history, which cannot answer for a meter-area device. So
  // "No activity recorded yet" would read as a quiet, healthy device. Say the
  // truth instead, and skip the fetch the answer cannot come from.
  if (isDeviceInMeterArea(params.deviceId)) {
    renderState({ status: 'notRecorded' });
    return;
  }
  if (params.showLoading) {
    showDeviceDetailActivityLogLoading();
  }
  try {
    const payload = parseDeviceActivityPayload(await getApiReadModel<unknown>(SETTINGS_UI_DEVICE_LOG_PATH));
    if (!params.isCurrentDevice() || activityLogRequestSeq !== requestSeq) return;
    const entries = payload.entries.filter((entry) => entry.deviceId === params.deviceId);
    renderState({ status: 'ready', entries, persistence: payload.persistence });
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
