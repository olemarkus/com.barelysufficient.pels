import { SETTINGS_UI_DEVICE_LOG_PATH } from '../../../contracts/src/settingsUi/paths.ts';
import { parseDeviceActivityPayload } from './activityHistoryPayload.ts';
import { getApiReadModel } from './homey.ts';
import { logSettingsError } from './logging.ts';
import { formatActivityTimestamp } from './activityTimestamp.ts';
import { renderActivityHistoryView, type ActivityHistoryState } from './views/ActivityHistoryView.tsx';

let requestSequence = 0;

const show = (state: ActivityHistoryState): void => {
  const surface = document.getElementById('activity-history-root');
  if (!surface) return;
  renderActivityHistoryView(surface, {
    state, formatTimestamp: formatActivityTimestamp, onRefresh: refreshActivityHistory,
  });
};

export const refreshActivityHistory = async (): Promise<void> => {
  const request = ++requestSequence;
  show({ status: 'loading' });
  try {
    const payload = parseDeviceActivityPayload(await getApiReadModel<unknown>(SETTINGS_UI_DEVICE_LOG_PATH));
    if (request === requestSequence) show({ status: 'ready', payload });
  } catch (error) {
    if (request !== requestSequence) return;
    show({ status: 'error' });
    await logSettingsError('Failed to load activity history', error, 'activity');
  }
};
