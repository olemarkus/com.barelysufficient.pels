import type { TargetDeviceSnapshot } from '../../../../contracts/src/types.ts';
import { NATIVE_EV_WIRING_DEVICES } from '../../../../contracts/src/settingsKeys.ts';
import {
  deviceDetailNativeWiring,
  deviceDetailNativeWiringConfirm,
  deviceDetailNativeWiringConfirmRow,
  deviceDetailNativeWiringNotice,
  deviceDetailNativeWiringNoticeAction,
  deviceDetailNativeWiringRow,
  deviceDetailSetupDisclosure,
} from '../dom.ts';
import { requiresNativeWiringForActivation, supportsNativeWiringActivation } from '../deviceUtils.ts';
import { state } from '../state.ts';
import { readRecordSettingStrict, writeFreshSetting } from './settingsWrite.ts';

let nativeWiringActivationPendingDeviceId: string | null = null;
// Tracks the device id we have already auto-expanded the Setup disclosure
// for. Refresh paths (devices-updated, snapshot refresh, plan-updated) call
// setDeviceDetailNativeWiringState repeatedly; without this guard we would
// fight the user every time they manually close the disclosure.
let setupAutoExpandedForDeviceId: string | null = null;

export const retainPendingNativeWiringEnable = (deviceId: string) => {
  nativeWiringActivationPendingDeviceId = nativeWiringActivationPendingDeviceId === deviceId ? deviceId : null;
};

export const clearPendingNativeWiringEnable = () => {
  nativeWiringActivationPendingDeviceId = null;
  setupAutoExpandedForDeviceId = null;
};

const expandSetupDisclosure = () => {
  if (deviceDetailSetupDisclosure && !deviceDetailSetupDisclosure.open) {
    deviceDetailSetupDisclosure.open = true;
  }
};

const syncNativeWiringRequirementSurfaces = (
  device: TargetDeviceSnapshot | null,
  required: boolean,
) => {
  if (deviceDetailNativeWiringNotice) {
    deviceDetailNativeWiringNotice.hidden = !required;
  }
  if (!required) {
    setupAutoExpandedForDeviceId = null;
    return;
  }
  if (device && setupAutoExpandedForDeviceId !== device.id) {
    setupAutoExpandedForDeviceId = device.id;
    expandSetupDisclosure();
  }
};

export const setDeviceDetailNativeWiringState = (device: TargetDeviceSnapshot | null) => {
  const nativeWiringSupported = supportsNativeWiringActivation(device);
  const nativeWiringEffectiveEnabled = device
    ? state.nativeWiringMap[device.id] === true || device.controlAdapter?.activationEnabled === true
    : false;
  const nativeWiringActivationPending = device
    && nativeWiringActivationPendingDeviceId === device.id
    && !nativeWiringEffectiveEnabled;
  const nativeWiringRequiredAndMissing = requiresNativeWiringForActivation(device)
    && !nativeWiringActivationPending;

  if (deviceDetailNativeWiringRow) {
    deviceDetailNativeWiringRow.hidden = !nativeWiringSupported;
  }
  if (deviceDetailNativeWiring) {
    deviceDetailNativeWiring.selected = nativeWiringEffectiveEnabled || nativeWiringActivationPending;
    deviceDetailNativeWiring.disabled = !nativeWiringSupported;
  }
  if (deviceDetailNativeWiringConfirmRow) {
    deviceDetailNativeWiringConfirmRow.hidden = !nativeWiringActivationPending;
  }
  if (deviceDetailNativeWiringConfirm) {
    deviceDetailNativeWiringConfirm.selected = false;
    deviceDetailNativeWiringConfirm.disabled = !nativeWiringActivationPending;
  }
  syncNativeWiringRequirementSurfaces(device, nativeWiringRequiredAndMissing);
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

  const persistNativeWiringEnabled = async (deviceId: string, nativeWiringEnabled: boolean) => {
    await writeFreshSetting<Record<string, boolean>>({
      key: NATIVE_EV_WIRING_DEVICES,
      context: 'device detail',
      logMessage: 'Failed to update native wiring setting',
      toastMessage: 'Failed to update built-in device control.',
      // Use the live native-wiring snapshot as the fallback so a transient
      // null or non-object SDK read does not erase entries for other
      // devices.
      fallbackValue: state.nativeWiringMap,
      readFresh: readRecordSettingStrict<boolean>,
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
    if (deviceDetailNativeWiring.selected) {
      if (nativeWiringEffectiveEnabled) return;
      nativeWiringActivationPendingDeviceId = deviceId;
      refreshOpenDeviceDetail();
      return;
    }

    nativeWiringActivationPendingDeviceId = null;

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
    if (!deviceDetailNativeWiringConfirm.selected) return;

    await persistNativeWiringEnabled(deviceId, true);
  });

  deviceDetailNativeWiringNoticeAction?.addEventListener('click', () => {
    // Explicit user request: always re-expand and reset the auto-expand
    // tracker so the user-driven open survives subsequent state refreshes.
    setupAutoExpandedForDeviceId = getCurrentDetailDeviceId();
    expandSetupDisclosure();
    if (!deviceDetailNativeWiringRow || deviceDetailNativeWiringRow.hidden) return;
    // jsdom does not implement scrollIntoView; tolerate it.
    deviceDetailNativeWiringRow.scrollIntoView?.({ behavior: 'smooth', block: 'center' });
    deviceDetailNativeWiring?.focus?.();
  });
};
