import {
  deviceDetailControllable,
  deviceDetailManaged,
} from '../dom.ts';
import { renderDevices } from '../devices.ts';
import { state } from '../state.ts';
import { readRecordSetting, writeFreshSetting } from './settingsWrite.ts';

export function initDeviceDetailManagedControlHandlers(params: {
  getCurrentDetailDeviceId: () => string | null;
  refreshCurrentDeviceControlStates: () => void;
  refreshSharedDeviceViews: () => void;
}) {
  deviceDetailControllable?.addEventListener('change', async () => {
    const deviceId = params.getCurrentDetailDeviceId();
    if (!deviceId || !deviceDetailControllable) return;

    const nextChecked = deviceDetailControllable.checked;
    await writeFreshSetting<Record<string, boolean>>({
      key: 'controllable_devices',
      context: 'device detail',
      logMessage: 'Failed to update controllable device',
      toastMessage: 'Failed to update controllable device.',
      fallbackValue: {},
      readFresh: readRecordSetting<boolean>,
      mutate: (currentMap) => ({
        ...currentMap,
        [deviceId]: nextChecked,
      }),
      commit: (nextMap) => {
        state.controllableMap = nextMap;
        renderDevices(state.latestDevices);
      },
      rollback: params.refreshCurrentDeviceControlStates,
    });
  });

  deviceDetailManaged?.addEventListener('change', async () => {
    const deviceId = params.getCurrentDetailDeviceId();
    if (!deviceId || !deviceDetailManaged) return;

    const nextChecked = deviceDetailManaged.checked;
    await writeFreshSetting<Record<string, boolean>>({
      key: 'managed_devices',
      context: 'device detail',
      logMessage: 'Failed to update managed device',
      toastMessage: 'Failed to update managed device.',
      fallbackValue: {},
      readFresh: readRecordSetting<boolean>,
      mutate: (currentMap) => ({
        ...currentMap,
        [deviceId]: nextChecked,
      }),
      commit: (nextMap) => {
        state.managedMap = nextMap;
        params.refreshSharedDeviceViews();
        params.refreshCurrentDeviceControlStates();
      },
      rollback: params.refreshCurrentDeviceControlStates,
    });
  });
}
