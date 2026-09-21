import { refreshSettingsUiFlowConflictPayload } from '../lib/flowApi/settingsUiFlowConflictRefresh';
import { getSettingsUiDevicesPayload } from './settingsUiApi';
import { requestSettingsUiFlowConflictRefreshForApp } from './settingsUiAppRuntime';

type ApiContext = {
  homey: Parameters<typeof requestSettingsUiFlowConflictRefreshForApp>[0];
};

/** Wire the settings endpoint to the Flow-conflict refresh use case. */
export const refreshSettingsUiFlowConflicts = (
  { homey }: ApiContext,
) => refreshSettingsUiFlowConflictPayload({
  requestRefresh: () => requestSettingsUiFlowConflictRefreshForApp(homey),
  readDevices: () => getSettingsUiDevicesPayload({ homey }).devices,
});
