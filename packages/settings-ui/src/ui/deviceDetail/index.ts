import { hideDeviceDetailLiveStatus, renderDeviceDetailLiveStatus } from './liveStatus.ts';
import type {
  DeviceControlProfiles,
  SteppedLoadProfile,
} from '../../../../contracts/src/types.ts';
import { normalizeDeviceControlProfiles } from '../../../../contracts/src/deviceControlProfiles.ts';
import {
  deviceDetailOverlay,
  deviceDetailTitle,
  deviceDetailManaged,
  deviceDetailControllable,
  deviceDetailPriceOpt,
  deviceDetailSurplusOpt,
  deviceDetailSurplusOptRow,
  deviceDetailControlModelRow,
  deviceDetailControlModel,
} from '../dom.ts';
import { renderDevices } from '../devices.ts';
import {
  applyLocalDeviceControlProfile,
  createDefaultSteppedLoadProfile,
  isNativeSteppedLoadProfileActive,
} from '../deviceControlProfiles.ts';
import { renderPriorities } from '../modes.ts';
import { renderPriceOptimization } from '../priceOptimization.ts';
import { resolveHomeExhibitsSolar, state } from '../state.ts';
import { renderDeviceDetailModes } from './modes.ts';
import { DEVICE_CONTROL_PROFILES } from '../../../../contracts/src/settingsKeys.ts';
import {
  resetDeviceDetailDiagnosticsRequests,
  resetDeviceDetailDiagnosticsView,
} from './diagnostics.ts';
import {
  initDeviceDetailActivityLogToggleHandler,
  resetDeviceDetailActivityLogRequests,
  resetDeviceDetailActivityLogView,
} from './activityLog.ts';
import {
  initDeviceDetailPriceOptHandlers,
  setDeviceDetailDeltaValues,
  updateDeltaSectionVisibility,
} from './priceOpt.ts';
import {
  initDeviceDetailSurplusOptHandlers,
  setDeviceDetailDumpLoadControl,
  setDeviceDetailSurplusValues,
  updateSurplusSectionVisibility,
} from './solarSurplus.ts';
import {
  initDeviceDetailShedHandlers,
  loadShedBehaviors,
  setDeviceDetailShedBehavior,
  updateShedFieldVisibility,
} from './shedBehavior.ts';
import { setDeviceDetailSocState } from './socState.ts';
import {
  closeSteppedLoadDraft,
  initSteppedLoadDraftHandlers,
  isSteppedLoadControlModel,
  renderSteppedLoadDraft,
  resolveSavedSteppedLoadProfile,
  updateSetStepOptionLabel,
} from './steppedLoadDraft.ts';
import {
  initEvBoostHandlers,
  loadEvBoostSettings,
  renderEvBoostSettings,
} from './evBoost.ts';
import {
  initTemperatureBoostHandlers,
  loadTemperatureBoostSettings,
  renderTemperatureBoostSettings,
} from './temperatureBoost.ts';
import { createSerializedAsyncRunner, writeFreshSetting } from './settingsWrite.ts';
import {
  clearPendingNativeWiringEnable,
  initDeviceDetailNativeWiringHandler,
  retainPendingNativeWiringEnable,
  setDeviceDetailNativeWiringState,
} from './nativeWiring.ts';
import {
  initTargetPowerConfigHandlers,
  persistTargetPowerConfig,
  renderTargetPowerConfig,
} from './targetPowerConfig.ts';
import {
  isControlModeAllowedForDevice,
  normalizeDeviceDetailControlMode,
  resolveDeviceDetailControlMode,
  resolveTargetPowerConfigForControlMode,
  syncDeviceDetailControlModeOptions,
} from './controlMode.ts';
import { resolveDeviceDetailControlState, setTemperatureGatedSwitch } from './controlState.ts';
import { createPendingDeviceDetailOpen } from './focus.ts';
import {
  initDeviceDetailBudgetExemptHandler,
  setDeviceDetailBudgetExemptState,
} from './budgetExempt.ts';
import { initRespectExternalOffHandler, syncRespectExternalOffRow } from './respectExternalOff.ts';
import { initDeviceDetailManagedControlHandlers } from './managedControl.ts';
import {
  initDeviceDetailOverlayChrome,
  initDeviceDetailOverlaySubscriptions,
} from './overlayHandlers.ts';
import { formatDisplayDeviceName } from '../../../../shared-domain/src/displayDeviceName.ts';

let currentDetailDeviceId: string | null = null;
const pendingDeviceDetailOpen = createPendingDeviceDetailOpen();
const runSerializedDeviceControlProfileWrite = createSerializedAsyncRunner();

const getCurrentDetailDeviceId = () => currentDetailDeviceId;

const getDeviceById = (deviceId: string) => state.latestDevices.find((device) => device.id === deviceId) || null;

const setDeviceDetailTitle = (name: string) => {
  if (!deviceDetailTitle) return;
  const displayName = formatDisplayDeviceName(name);
  deviceDetailTitle.textContent = displayName;
  // The app-bar title is single-line + ellipsis; carry the full name in `title`
  // so a long device name that clips stays recoverable on hover / long-press.
  deviceDetailTitle.setAttribute('title', displayName);
};

const refreshSharedDeviceViews = () => {
  renderDevices(state.latestDevices);
  renderPriorities(state.latestDevices);
  renderPriceOptimization(state.latestDevices);
};

const refreshCurrentDeviceControlStates = () => {
  const activeDeviceId = getCurrentDetailDeviceId();
  if (!activeDeviceId) return;
  setDeviceDetailControlStates(activeDeviceId);
  updateDeltaSectionVisibility({
    currentDetailDeviceId: activeDeviceId,
    getDeviceById,
  });
  updateSurplusSectionVisibility({
    currentDetailDeviceId: activeDeviceId,
    getDeviceById,
  });
};

const notifyDevicesUpdated = () => {
  document.dispatchEvent(new CustomEvent('devices-updated', { detail: { devices: state.latestDevices } }));
};

const showDeviceDetailOverlay = () => {
  if (deviceDetailOverlay) {
    deviceDetailOverlay.hidden = false;
  }
};

const setDeviceDetailControlStates = (deviceId: string) => {
  const device = getDeviceById(deviceId);
  const controlState = resolveDeviceDetailControlState(device, deviceId);

  setDeviceDetailNativeWiringState(device);

  if (deviceDetailManaged) {
    deviceDetailManaged.selected = controlState.isManaged;
    deviceDetailManaged.disabled = !controlState.canManageDevice;
  }
  if (deviceDetailControllable) {
    deviceDetailControllable.selected = controlState.supportsPower && state.controllableMap[deviceId] === true;
    deviceDetailControllable.disabled = !controlState.supportsPower || !controlState.isManaged;
  }
  const priceConfig = state.priceOptimizationSettings[deviceId];
  setTemperatureGatedSwitch(deviceDetailPriceOpt, priceConfig?.enabled, controlState);
  setTemperatureGatedSwitch(deviceDetailSurplusOpt, priceConfig?.surplusWilling, controlState);
  if (deviceDetailSurplusOptRow) {
    // The surplus control is solar-only: hide the whole row unless the home exhibits solar
    // (a tracked solar/PV device OR material grid export from a meter-only PV inverter) AND
    // this is a temperature device (the only kind that can self-consume by raising a
    // setpoint). On a non-solar home or a non-temperature device it is hidden outright
    // rather than shown disabled, so it never clutters a home that cannot export.
    deviceDetailSurplusOptRow.hidden = !(resolveHomeExhibitsSolar() && controlState.supportsTemperature);
  }
  // Binary sibling: the "Run on solar surplus" dump-load posture row (solarSurplus.ts
  // owns the gate — managed binary device, solar present, not temperature/stepped/EV).
  setDeviceDetailDumpLoadControl({ deviceId, getDeviceById });
  syncRespectExternalOffRow({ deviceId, getDeviceById });

  setDeviceDetailBudgetExemptState(device);
  setDeviceDetailSocState(device);
  if (deviceDetailControlModel && deviceDetailControlModelRow) {
    const effectiveControlMode = device ? resolveDeviceDetailControlMode(device) : 'default';
    const nativeSteppedLoadLocked = isNativeSteppedLoadProfileActive(device);
    syncDeviceDetailControlModeOptions(deviceDetailControlModel, device, effectiveControlMode);
    deviceDetailControlModel.value = effectiveControlMode;
    deviceDetailControlModel.disabled = !controlState.canManageDevice || nativeSteppedLoadLocked;
    deviceDetailControlModelRow.hidden = !controlState.canManageDevice;
  }
};

const persistDeviceControlProfile = async (deviceId: string, profile: SteppedLoadProfile | null): Promise<boolean> => (
  runSerializedDeviceControlProfileWrite(async () => {
    let didPersist = false;
    await writeFreshSetting<DeviceControlProfiles>({
      key: DEVICE_CONTROL_PROFILES,
      context: 'device detail',
      logMessage: 'Failed to save device control profile',
      toastMessage: 'Failed to save device control profile.',
      // Use the live in-memory profiles map as the snapshot fallback so
      // that a transient null SDK read does not erase profiles for other
      // devices. The first-write case is still safe: when no profiles
      // exist locally either, the merged write is the user's new entry
      // alone.
      fallbackValue: state.deviceControlProfiles,
      // Only normalize when the fresh SDK value is a real object.
      // Anything else returns null so `writeFreshSetting` falls back to
      // the snapshot instead of normalising garbage into `{}`.
      readFresh: (value) => (
        value && typeof value === 'object' && !Array.isArray(value)
          ? normalizeDeviceControlProfiles(value)
          : null
      ),
      mutate: (currentProfiles) => {
        const nextProfiles = { ...currentProfiles };
        if (profile) {
          nextProfiles[deviceId] = profile;
        } else {
          delete nextProfiles[deviceId];
        }
        return nextProfiles;
      },
      commit: (nextProfiles) => {
        state.deviceControlProfiles = nextProfiles;
        applyLocalDeviceControlProfile(deviceId, profile);
        refreshSharedDeviceViews();
        notifyDevicesUpdated();
        didPersist = true;
      },
      rollback: () => {
        if (currentDetailDeviceId === deviceId) {
          refreshOpenDeviceDetail();
        }
      },
    });
    return didPersist;
  })
);

const refreshOpenDeviceDetail = () => {
  if (!currentDetailDeviceId) return;

  const device = getDeviceById(currentDetailDeviceId);
  if (!device) {
    closeDeviceDetail();
    return;
  }

  setDeviceDetailTitle(device.name);
  void renderDeviceDetailLiveStatus(currentDetailDeviceId);
  setDeviceDetailControlStates(currentDetailDeviceId);
  setDeviceDetailShedBehavior({
    deviceId: currentDetailDeviceId,
    getDeviceById,
    isSteppedLoadControlModel,
    updateSetStepOptionLabel,
  });
  renderSteppedLoadDraft(device);
  renderTargetPowerConfig(device);
  renderTemperatureBoostSettings(device);
  renderEvBoostSettings(device);
  setDeviceDetailDeltaValues(currentDetailDeviceId);
  setDeviceDetailSurplusValues(currentDetailDeviceId);
  renderDeviceDetailModes(device);
  updateDeltaSectionVisibility({
    currentDetailDeviceId,
    getDeviceById,
  });
  updateSurplusSectionVisibility({
    currentDetailDeviceId,
    getDeviceById,
  });
  updateShedFieldVisibility({
    currentDetailDeviceId,
    getDeviceById,
    isSteppedLoadControlModel,
  });
};

export const openDeviceDetail = (deviceId: string) => {
  const device = getDeviceById(deviceId);
  if (!device) return;

  resetDeviceDetailDiagnosticsRequests();
  resetDeviceDetailActivityLogRequests();
  // Do not drop drafts here: switching from device A's pane to device B's must
  // preserve A's in-progress edits per TODO `stepped-load-draft-close-handler`.
  // The draft for B (if any) is loaded via renderSteppedLoadDraft below.
  retainPendingNativeWiringEnable(deviceId);
  currentDetailDeviceId = deviceId;

  setDeviceDetailTitle(device.name);
  void renderDeviceDetailLiveStatus(deviceId);
  setDeviceDetailControlStates(deviceId);
  setDeviceDetailShedBehavior({
    deviceId,
    getDeviceById,
    isSteppedLoadControlModel,
    updateSetStepOptionLabel,
  });
  renderSteppedLoadDraft(device);
  renderTargetPowerConfig(device);
  renderTemperatureBoostSettings(device);
  renderEvBoostSettings(device);
  renderDeviceDetailModes(device);
  setDeviceDetailDeltaValues(deviceId);
  setDeviceDetailSurplusValues(deviceId);
  updateDeltaSectionVisibility({
    currentDetailDeviceId: deviceId,
    getDeviceById,
  });
  updateSurplusSectionVisibility({
    currentDetailDeviceId: deviceId,
    getDeviceById,
  });
  updateShedFieldVisibility({
    currentDetailDeviceId: deviceId,
    getDeviceById,
    isSteppedLoadControlModel,
  });

  resetDeviceDetailDiagnosticsView();
  resetDeviceDetailActivityLogView();
  showDeviceDetailOverlay();
};

export const closeDeviceDetail = () => {
  resetDeviceDetailDiagnosticsRequests();
  resetDeviceDetailDiagnosticsView();
  resetDeviceDetailActivityLogRequests();
  resetDeviceDetailActivityLogView();
  if (currentDetailDeviceId) {
    closeSteppedLoadDraft(currentDetailDeviceId);
  }
  clearPendingNativeWiringEnable();
  hideDeviceDetailLiveStatus();
  currentDetailDeviceId = null;
  if (deviceDetailOverlay) {
    deviceDetailOverlay.hidden = true;
  }
};

const initDeviceDetailControlModelHandler = () => {
  deviceDetailControlModel?.addEventListener('change', async () => {
    const deviceId = currentDetailDeviceId;
    if (!deviceId || !deviceDetailControlModel) return;

    const device = getDeviceById(deviceId);
    if (!device) return;
    if (isNativeSteppedLoadProfileActive(device)) {
      refreshOpenDeviceDetail();
      return;
    }

    const controlMode = normalizeDeviceDetailControlMode(deviceDetailControlModel.value);
    if (!controlMode || !isControlModeAllowedForDevice(controlMode, device)) {
      refreshOpenDeviceDetail();
      return;
    }
    const nextTargetPowerConfig = resolveTargetPowerConfigForControlMode(controlMode, device);
    const nextProfile = controlMode === 'stepped_load'
      ? resolveSavedSteppedLoadProfile(device) ?? createDefaultSteppedLoadProfile(device)
      : null;
    const didPersist = await persistDeviceControlProfile(deviceId, nextProfile);
    if (!didPersist) return;
    await persistTargetPowerConfig({
      deviceId,
      config: nextTargetPowerConfig,
      refreshOpenDeviceDetail,
    });
    if (controlMode === 'default' || controlMode === 'stepped_load') {
      refreshOpenDeviceDetail();
    }
  });
};

export { loadEvBoostSettings, loadShedBehaviors, loadTemperatureBoostSettings };

export const initDeviceDetailHandlers = () => {
  const overlayContext = {
    getCurrentDetailDeviceId,
    getDeviceById,
    openDeviceDetail,
    closeDeviceDetail,
    refreshOpenDeviceDetail,
    pendingDeviceDetailOpen,
  };
  initDeviceDetailOverlayChrome(overlayContext);
  initDeviceDetailNativeWiringHandler({
    getCurrentDetailDeviceId,
    getDeviceById,
    refreshCurrentDeviceControlStates,
    refreshOpenDeviceDetail,
    refreshSharedDeviceViews,
  });
  initDeviceDetailManagedControlHandlers({
    getCurrentDetailDeviceId,
    refreshCurrentDeviceControlStates,
    refreshSharedDeviceViews,
  });
  initDeviceDetailControlModelHandler();
  initDeviceDetailPriceOptHandlers({
    getCurrentDetailDeviceId,
    getDeviceById,
  });
  initDeviceDetailSurplusOptHandlers({
    getCurrentDetailDeviceId,
    getDeviceById,
  });
  initDeviceDetailBudgetExemptHandler({
    getCurrentDetailDeviceId,
    getDeviceById,
    refreshSharedDeviceViews,
    refreshOpenDeviceDetail,
  });
  initRespectExternalOffHandler({ getCurrentDetailDeviceId, refreshSharedDeviceViews, refreshOpenDeviceDetail });
  initDeviceDetailShedHandlers({
    getCurrentDetailDeviceId,
    getDeviceById,
    isSteppedLoadControlModel,
  });
  initSteppedLoadDraftHandlers({
    getCurrentDetailDeviceId,
    getDeviceById,
    persistDeviceControlProfile,
    refreshOpenDeviceDetail,
  });
  initTargetPowerConfigHandlers({
    getCurrentDetailDeviceId,
    refreshOpenDeviceDetail,
  });
  initEvBoostHandlers({
    getCurrentDetailDeviceId,
    getDeviceById,
    refreshOpenDeviceDetail,
  });
  initTemperatureBoostHandlers({
    getCurrentDetailDeviceId,
    getDeviceById,
    refreshOpenDeviceDetail,
  });
  initDeviceDetailActivityLogToggleHandler(() => currentDetailDeviceId);
  // Registration order note: the diagnostics `toggle` listener used to bind
  // just BEFORE this activity-log one; grouping the overlay subscriptions moved
  // it after. Unobservable — the two bind `toggle` on different elements
  // (`deviceDetailDiagnosticsDisclosure` vs `deviceDetailActivityLogDisclosure`),
  // so neither can preempt the other. Every `document`-level listener
  // (`keydown`, `open-device-detail`, `devices-updated`, `plan-updated`) keeps
  // its original position, which is where order would have mattered.
  initDeviceDetailOverlaySubscriptions(overlayContext);
};
