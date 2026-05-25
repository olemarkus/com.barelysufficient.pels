import {
  deviceDetailControllable,
  deviceDetailManaged,
} from '../dom.ts';
import { renderDevices } from '../devices.ts';
import { state } from '../state.ts';
import { readRecordSettingStrict, writeFreshSetting } from './settingsWrite.ts';

export function initDeviceDetailManagedControlHandlers(params: {
  getCurrentDetailDeviceId: () => string | null;
  refreshCurrentDeviceControlStates: () => void;
  refreshSharedDeviceViews: () => void;
}) {
  deviceDetailControllable?.addEventListener('change', async () => {
    const deviceId = params.getCurrentDetailDeviceId();
    if (!deviceId || !deviceDetailControllable) return;

    const nextChecked = deviceDetailControllable.selected;
    await writeFreshSetting<Record<string, boolean>>({
      key: 'controllable_devices',
      context: 'device detail',
      logMessage: 'Failed to update controllable device',
      toastMessage: 'Failed to update controllable device.',
      // Use the live controllable-map snapshot as the fallback so a
      // transient null or non-object SDK read does not erase entries for
      // other devices.
      fallbackValue: state.controllableMap,
      readFresh: readRecordSettingStrict<boolean>,
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

    const nextChecked = deviceDetailManaged.selected;
    await writeFreshSetting<Record<string, boolean>>({
      key: 'managed_devices',
      context: 'device detail',
      logMessage: 'Failed to update managed device',
      toastMessage: 'Failed to update managed device.',
      // Use the live managed-map snapshot as the fallback so a transient
      // null or non-object SDK read does not erase entries for other
      // devices.
      fallbackValue: state.managedMap,
      readFresh: readRecordSettingStrict<boolean>,
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
