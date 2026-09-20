import {
  deviceDetailControllable,
  deviceDetailManaged,
} from '../dom.ts';
import { renderDevices } from '../devices.ts';
import { state } from '../state.ts';
import { showToast } from '../toast.ts';
import { ensureChargerPhasePresetsRead } from '../chargerPhasePresets.ts';
import {
  beginManagedControlIntent,
  isCurrentManagedControlIntent,
} from '../managedControlIntent.ts';
import {
  createSerializedAsyncRunner,
  readRecordSettingStrict,
  writeFreshSetting,
} from './settingsWrite.ts';
import { applyManagedOptInControlMode } from './targetPowerConfig.ts';
import { applyManagedOptInLimit } from './managedOptInLimit.ts';

const runSerializedManagedWrite = createSerializedAsyncRunner();

export function initDeviceDetailManagedControlHandlers(
  getCurrentDetailDeviceId: () => string | null,
  refreshCurrentDeviceControlStates: () => void,
  refreshOpenDeviceDetail: () => void,
  refreshSharedDeviceViews: () => void,
) {
  deviceDetailControllable?.addEventListener('change', async () => {
    const deviceId = getCurrentDetailDeviceId();
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
        // Other controls in this panel gate on Power-limit control — the
        // "Leave off until turned on again" switch is disabled with a hint
        // naming it as the prerequisite. `renderDevices` only redraws the LIST,
        // so without this the user follows the hint, turns Power-limit control
        // on, and the switch they were sent to stays disabled until they
        // reopen the panel.
        refreshCurrentDeviceControlStates();
      },
      rollback: refreshCurrentDeviceControlStates,
    });
  });

  deviceDetailManaged?.addEventListener('change', async () => {
    const deviceId = getCurrentDetailDeviceId();
    if (!deviceId || !deviceDetailManaged) return;

    const nextChecked = deviceDetailManaged.selected;
    const intentGeneration = beginManagedControlIntent(deviceId);
    const device = state.latestDevices.find((entry) => entry.id === deviceId);
    const phaseRead = nextChecked && device?.deviceClass === 'evcharger'
      ? await ensureChargerPhasePresetsRead()
      : { state: 'resolved' as const, presets: state.chargerPhasePresets };
    if (!isCurrentManagedControlIntent(deviceId, intentGeneration)) return;
    if (phaseRead.state === 'unavailable') {
      deviceDetailManaged.selected = false;
      await showToast('Could not read the charger wiring. Refresh devices and try again.', 'warn');
      refreshCurrentDeviceControlStates();
      return;
    }
    const saved = await runSerializedManagedWrite(async () => {
      if (!isCurrentManagedControlIntent(deviceId, intentGeneration)) return false;
      const nextMap = await writeFreshSetting<Record<string, boolean>>({
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
        commit: (committedMap) => {
          state.managedMap = committedMap;
          refreshSharedDeviceViews();
          refreshCurrentDeviceControlStates();
        },
        rollback: refreshCurrentDeviceControlStates,
      });
      return nextMap !== null;
    });
    if (saved && nextChecked && isCurrentManagedControlIntent(deviceId, intentGeneration)) {
      await applyManagedOptInControlMode(deviceId, phaseRead.presets, refreshOpenDeviceDetail);
      // The write above awaited: an owner who has turned Managed back off since
      // must not get Limit switched on for a device they just let go of.
      if (!isCurrentManagedControlIntent(deviceId, intentGeneration)) return;
      await applyManagedOptInLimit(deviceId, () => {
        refreshSharedDeviceViews();
        refreshCurrentDeviceControlStates();
      }, () => isCurrentManagedControlIntent(deviceId, intentGeneration));
    }
  });
}
