import { setChargingCurrentDevice } from './chargingCurrent.tsx';
import { NATIVE_EV_WIRING_DEVICES } from '../../../../shared-domain/src/settings/settingsKeys.ts';
import {
  deviceDetailFlowConflictBody,
  deviceDetailFlowConflictCheck,
  deviceDetailFlowConflictNotice,
  deviceDetailFlowConflictTitle,
  deviceDetailNativeWiring,
  deviceDetailNativeWiringNotice,
  deviceDetailNativeWiringNoticeAction,
  deviceDetailNativeWiringRow,
  deviceDetailSetupDisclosure,
} from '../dom.ts';
import { nativeWiringFlowConflictNotice } from './nativeWiringCopy.ts';
import {
  isBuiltInControlChosen,
  requiresNativeWiringForActivation,
  supportsNativeWiringActivation,
  type SettingsUiDeviceDetailItem,
} from '../deviceUtils.ts';
import { state } from '../state.ts';
import { readRecordSettingStrict, writeFreshSetting } from './settingsWrite.ts';
import { checkFlowConflictNow } from '../flowConflictRefresh.ts';
import { showToast, showToastError } from '../toast.ts';

// Tracks the device id we have already auto-expanded the Setup disclosure
// for. Refresh paths (devices-updated, snapshot refresh, plan-updated) call
// setDeviceDetailNativeWiringState repeatedly; without this guard we would
// fight the user every time they manually close the disclosure.
let setupAutoExpandedForDeviceId: string | null = null;
let nativeWiringSaveInProgress = false;

export const resetNativeWiringSetupDisclosure = () => {
  setupAutoExpandedForDeviceId = null;
};

const expandSetupDisclosure = () => {
  if (deviceDetailSetupDisclosure && !deviceDetailSetupDisclosure.open) {
    deviceDetailSetupDisclosure.open = true;
  }
};

const hasFlowConflict = (device: SettingsUiDeviceDetailItem | null): boolean => (
  (device?.flowConflict?.conflictingCapabilities?.length ?? 0) > 0
);

const syncFlowConflictNotice = (
  device: SettingsUiDeviceDetailItem | null,
  builtInChosen: boolean,
): boolean => {
  // A Flow remains relevant after opt-in: it holds the owner's choice back.
  const hasConflict = hasFlowConflict(device);
  if (deviceDetailFlowConflictNotice) {
    deviceDetailFlowConflictNotice.hidden = !hasConflict;
  }
  if (!hasConflict) return false;
  const notice = nativeWiringFlowConflictNotice(device?.flowConflict?.flowName, builtInChosen);
  if (deviceDetailFlowConflictTitle) deviceDetailFlowConflictTitle.textContent = notice.title;
  if (deviceDetailFlowConflictBody) deviceDetailFlowConflictBody.textContent = notice.body;
  return true;
};

const syncNativeWiringRequirementSurfaces = (required: boolean) => {
  if (deviceDetailNativeWiringNotice) {
    deviceDetailNativeWiringNotice.hidden = !required;
  }
};

// Auto-expand the Setup disclosure once per device when it holds a notice the
// user needs to see (activation required, or a flow conflict — both render
// inside the collapsed `<details>`). The per-device guard keeps refreshes from
// fighting a manual re-close.
const syncSetupAutoExpand = (device: SettingsUiDeviceDetailItem | null, shouldExpand: boolean) => {
  if (!shouldExpand) {
    setupAutoExpandedForDeviceId = null;
    return;
  }
  if (device && setupAutoExpandedForDeviceId !== device.id) {
    setupAutoExpandedForDeviceId = device.id;
    expandSetupDisclosure();
  }
};

export const setDeviceDetailNativeWiringState = (device: SettingsUiDeviceDetailItem | null) => {
  setChargingCurrentDevice(device?.id ?? '');
  const nativeWiringSupported = supportsNativeWiringActivation(device);
  const builtInChosen = device ? isBuiltInControlChosen(device, state.nativeWiringMap) : false;
  const nativeWiringRequiredAndMissing = requiresNativeWiringForActivation(device);

  if (deviceDetailNativeWiringRow) {
    deviceDetailNativeWiringRow.hidden = !nativeWiringSupported;
  }
  if (deviceDetailNativeWiring) {
    deviceDetailNativeWiring.selected = builtInChosen;
    // A conflicting Flow blocks turning it on; an owner who chose it can still turn it off.
    deviceDetailNativeWiring.disabled = !nativeWiringSupported || nativeWiringSaveInProgress
      || (hasFlowConflict(device) && !builtInChosen);
  }
  syncNativeWiringRequirementSurfaces(nativeWiringRequiredAndMissing);
  const showsFlowConflict = syncFlowConflictNotice(device, builtInChosen);
  syncSetupAutoExpand(device, nativeWiringRequiredAndMissing || showsFlowConflict);
};

export const updateCurrentDeviceNativeWiringSnapshot = (
  device: SettingsUiDeviceDetailItem | null,
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
  getDeviceById: (deviceId: string) => SettingsUiDeviceDetailItem | null;
  refreshCurrentDeviceControlStates: () => void;
  refreshSharedDeviceViews: () => void;
}) => {
  const {
    getCurrentDetailDeviceId,
    getDeviceById,
    refreshCurrentDeviceControlStates,
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
        refreshSharedDeviceViews();
        refreshCurrentDeviceControlStates();
      },
      rollback: refreshCurrentDeviceControlStates,
    });
  };

  deviceDetailNativeWiring?.addEventListener('change', async () => {
    const deviceId = getCurrentDetailDeviceId();
    if (!deviceId || !deviceDetailNativeWiring || nativeWiringSaveInProgress) return;

    const device = getDeviceById(deviceId);
    if (!supportsNativeWiringActivation(device)) return;

    const builtInChosen = isBuiltInControlChosen(device, state.nativeWiringMap);
    if (deviceDetailNativeWiring.selected === builtInChosen) return;
    if (deviceDetailNativeWiring.selected && hasFlowConflict(device)) {
      deviceDetailNativeWiring.selected = false;
      return;
    }
    nativeWiringSaveInProgress = true;
    deviceDetailNativeWiring.disabled = true;
    try {
      await persistNativeWiringEnabled(deviceId, deviceDetailNativeWiring.selected);
    } finally {
      nativeWiringSaveInProgress = false;
      refreshCurrentDeviceControlStates();
    }
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

  deviceDetailFlowConflictCheck?.addEventListener('click', async () => {
    const deviceId = getCurrentDetailDeviceId();
    if (!deviceId || deviceDetailFlowConflictCheck.disabled) return;
    deviceDetailFlowConflictCheck.disabled = true;
    deviceDetailFlowConflictCheck.textContent = 'Checking…';
    try {
      const hasConflict = await checkFlowConflictNow(deviceId);
      await showToast(
        hasConflict ? 'PELS still finds Flow control for this device.' : 'No conflicting Flow control found.',
        hasConflict ? 'warn' : 'ok',
      );
    } catch (error) {
      await showToastError(error, 'Could not check Homey Flows. Try again.');
    } finally {
      deviceDetailFlowConflictCheck.disabled = false;
      deviceDetailFlowConflictCheck.textContent = 'Check again';
    }
  });
};
