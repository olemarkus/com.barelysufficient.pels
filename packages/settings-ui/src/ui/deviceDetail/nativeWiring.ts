import type { TargetDeviceSnapshot } from '../../../../contracts/src/types.ts';
import { MANAGED_DEVICES, NATIVE_EV_WIRING_DEVICES } from '../../../../contracts/src/settingsKeys.ts';
import {
  deviceDetailNativeWiring,
  deviceDetailNativeWiringConfirm,
  deviceDetailNativeWiringConfirmRow,
  deviceDetailNativeWiringRow,
} from '../dom.ts';
import { supportsNativeWiringActivation } from '../deviceUtils.ts';
import { state } from '../state.ts';
import { readRecordSetting, writeFreshSetting } from './settingsWrite.ts';

let nativeWiringActivationPendingDeviceId: string | null = null;

export const retainPendingNativeWiringEnable = (deviceId: string) => {
  nativeWiringActivationPendingDeviceId = nativeWiringActivationPendingDeviceId === deviceId ? deviceId : null;
};

export const clearPendingNativeWiringEnable = () => {
  nativeWiringActivationPendingDeviceId = null;
};

export const setDeviceDetailNativeWiringState = (device: TargetDeviceSnapshot | null) => {
  const nativeWiringSupported = supportsNativeWiringActivation(device);
  const nativeWiringEffectiveEnabled = device
    ? state.nativeWiringMap[device.id] === true || device.controlAdapter?.activationEnabled === true
    : false;
  const nativeWiringActivationPending = device
    && nativeWiringActivationPendingDeviceId === device.id
    && !nativeWiringEffectiveEnabled;

  if (deviceDetailNativeWiringRow) {
    deviceDetailNativeWiringRow.hidden = !nativeWiringSupported;
  }
  if (deviceDetailNativeWiring) {
    deviceDetailNativeWiring.checked = nativeWiringEffectiveEnabled || nativeWiringActivationPending;
    deviceDetailNativeWiring.disabled = !nativeWiringSupported;
  }
  if (deviceDetailNativeWiringConfirmRow) {
    deviceDetailNativeWiringConfirmRow.hidden = !nativeWiringActivationPending;
  }
  if (deviceDetailNativeWiringConfirm) {
    deviceDetailNativeWiringConfirm.checked = false;
    deviceDetailNativeWiringConfirm.disabled = !nativeWiringActivationPending;
  }
};

export const updateCurrentDeviceNativeWiringSnapshot = (
  device: TargetDeviceSnapshot | null,
  nativeWiringEnabled: boolean,
) => {
  if (!device) return;
  const currentDevice = device;

  if (currentDevice.controlAdapter?.kind === 'capability_adapter') {
    currentDevice.controlAdapter = {
      ...currentDevice.controlAdapter,
      activationEnabled: nativeWiringEnabled,
    };
  }
};

export const initDeviceDetailNativeWiringHandler = (params: {
  getCurrentDetailDeviceId: () => string | null;
  getDeviceById: (deviceId: string) => TargetDeviceSnapshot | null;
  refreshCurrentDeviceControlStates: () => void;
  refreshOpenDeviceDetail: () => void;
  refreshSharedDeviceViews: () => void;
}) => {
  const {
    getCurrentDetailDeviceId,
    getDeviceById,
    refreshCurrentDeviceControlStates,
    refreshOpenDeviceDetail,
    refreshSharedDeviceViews,
  } = params;

  const disableManagedForDevice = async (deviceId: string): Promise<boolean> => {
    const nextMap = await writeFreshSetting<Record<string, boolean>>({
      key: MANAGED_DEVICES,
      context: 'device detail',
      logMessage: 'Failed to disable managed device',
      toastMessage: 'Failed to disable device management.',
      fallbackValue: {},
      readFresh: readRecordSetting<boolean>,
      mutate: (currentMap) => ({
        ...currentMap,
        [deviceId]: false,
      }),
      commit: (managedMap) => {
        state.managedMap = managedMap;
      },
      rollback: refreshCurrentDeviceControlStates,
    });
    return nextMap !== null;
  };

  const persistNativeWiringEnabled = async (deviceId: string, nativeWiringEnabled: boolean) => {
    await writeFreshSetting<Record<string, boolean>>({
      key: NATIVE_EV_WIRING_DEVICES,
      context: 'device detail',
      logMessage: 'Failed to update native wiring setting',
      toastMessage: 'Failed to update built-in charger control.',
      fallbackValue: {},
      readFresh: readRecordSetting<boolean>,
      mutate: (currentMap) => ({
        ...currentMap,
        [deviceId]: nativeWiringEnabled,
      }),
      commit: (nextMap) => {
        state.nativeWiringMap = nextMap;
        updateCurrentDeviceNativeWiringSnapshot(getDeviceById(deviceId), nativeWiringEnabled);
        nativeWiringActivationPendingDeviceId = null;
        refreshSharedDeviceViews();
        refreshCurrentDeviceControlStates();
      },
      rollback: refreshCurrentDeviceControlStates,
    });
  };

  deviceDetailNativeWiring?.addEventListener('change', async () => {
    const deviceId = getCurrentDetailDeviceId();
    if (!deviceId || !deviceDetailNativeWiring) return;

    const device = getDeviceById(deviceId);
    if (!supportsNativeWiringActivation(device)) return;

    const nativeWiringEffectiveEnabled = state.nativeWiringMap[deviceId] === true
      || device.controlAdapter?.activationEnabled === true;
    if (deviceDetailNativeWiring.checked) {
      if (nativeWiringEffectiveEnabled) return;
      nativeWiringActivationPendingDeviceId = deviceId;
      refreshOpenDeviceDetail();
      return;
    }

    nativeWiringActivationPendingDeviceId = null;
    if (!await disableManagedForDevice(deviceId)) return;

    if (!nativeWiringEffectiveEnabled) {
      refreshSharedDeviceViews();
      refreshOpenDeviceDetail();
      return;
    }

    await persistNativeWiringEnabled(deviceId, false);
  });

  deviceDetailNativeWiringConfirm?.addEventListener('change', async () => {
    const deviceId = getCurrentDetailDeviceId();
    if (!deviceId || !deviceDetailNativeWiringConfirm) return;
    if (nativeWiringActivationPendingDeviceId !== deviceId) return;
    if (!deviceDetailNativeWiringConfirm.checked) return;

    await persistNativeWiringEnabled(deviceId, true);
  });
};
