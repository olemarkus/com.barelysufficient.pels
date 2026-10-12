import { readPelsHost } from '../lib/app/pelsHost';
import { refreshSettingsUiFlowConflictPayload } from '../lib/flowApi/settingsUiFlowConflictRefresh';
import { getSettingsUiDevicesPayload } from './settingsUiApi';
import { appNotReadyError } from './settingsUiAppRuntime';

type ApiContext = {
  homey: Parameters<typeof getSettingsUiDevicesPayload>[0]['homey'];
};

/** Wire the settings endpoint to the Flow-conflict refresh use case. */
export const refreshSettingsUiFlowConflicts = (
  { homey }: ApiContext,
) => refreshSettingsUiFlowConflictPayload({
  requestRefresh: () => {
    const host = readPelsHost(homey);
    if (!host) throw appNotReadyError('Refresh Flow conflicts');
    return host.refreshFlowConflictsForUi();
  },
  readDevices: () => getSettingsUiDevicesPayload({ homey }).devices,
});
