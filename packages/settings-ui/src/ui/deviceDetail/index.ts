import type {
  DeviceControlProfiles,
  SteppedLoadProfile,
  TargetDeviceSnapshot,
} from '../../../../contracts/src/types.ts';
import { normalizeDeviceControlProfiles } from '../../../../contracts/src/deviceControlProfiles.ts';
import {
  deviceDetailDiagnosticsDisclosure,
  deviceDetailOverlay,
  deviceDetailPanel,
  deviceDetailTitle,
  deviceDetailClose,
  deviceDetailManaged,
  deviceDetailControllable,
  deviceDetailBudgetExempt,
  deviceDetailPriceOpt,
  deviceDetailControlModelRow,
  deviceDetailControlModel,
  deviceDetailShedAction,
} from '../dom.ts';
import { bindSegmentedToSelect } from '../components.ts';
import { renderDevices } from '../devices.ts';
import {
  applyLocalDeviceControlProfile,
  createDefaultSteppedLoadProfile,
  isNativeSteppedLoadProfileActive,
} from '../deviceControlProfiles.ts';
import { renderPriorities } from '../modes.ts';
import { renderPriceOptimization } from '../priceOptimization.ts';
import { state } from '../state.ts';
import { renderDeviceDetailModes } from './modes.ts';
import {
  BUDGET_EXEMPT_DEVICES,
  DEVICE_CONTROL_PROFILES,
} from '../../../../contracts/src/settingsKeys.ts';
import {
  isDeviceDetailDiagnosticsExpanded,
  refreshDeviceDetailDiagnostics,
  resetDeviceDetailDiagnosticsRequests,
  resetDeviceDetailDiagnosticsView,
  showDeviceDetailDiagnosticsLoading,
} from './diagnostics.ts';
import {
  initDeviceDetailPriceOptHandlers,
  setDeviceDetailDeltaValues,
  updateDeltaSectionVisibility,
} from './priceOpt.ts';
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
import { createSerializedAsyncRunner, readRecordSettingStrict, writeFreshSetting } from './settingsWrite.ts';
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
import { resolveDeviceDetailControlState } from './controlState.ts';
import { initDeviceDetailManagedControlHandlers } from './managedControl.ts';
import { formatDisplayDeviceName } from '../../../../shared-domain/src/displayDeviceName.ts';

let currentDetailDeviceId: string | null = null;
let pendingOpenDeviceId: string | null = null;
const runSerializedDeviceControlProfileWrite = createSerializedAsyncRunner();

const getCurrentDetailDeviceId = () => currentDetailDeviceId;

const getDeviceById = (deviceId: string) => state.latestDevices.find((device) => device.id === deviceId) || null;

const setDeviceDetailTitle = (name: string) => {
  if (deviceDetailTitle) deviceDetailTitle.textContent = formatDisplayDeviceName(name);
};

const setDeviceDetailBudgetExemptState = (device: TargetDeviceSnapshot | null) => {
  if (!deviceDetailBudgetExempt || !device) return;
  deviceDetailBudgetExempt.selected = state.budgetExemptMap[device.id] === true || device.budgetExempt === true;
  deviceDetailBudgetExempt.disabled = false;
};

const updateCurrentDeviceBudgetExemptSnapshot = (deviceId: string, budgetExempt: boolean) => {
  const device = getDeviceById(deviceId);
  if (device) {
    device.budgetExempt = budgetExempt;
  }
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
  if (deviceDetailPriceOpt) {
    const priceConfig = state.priceOptimizationSettings[deviceId];
    deviceDetailPriceOpt.selected = controlState.supportsTemperature
      && controlState.isManaged
      && priceConfig?.enabled === true;
    deviceDetailPriceOpt.disabled = !controlState.supportsTemperature || !controlState.isManaged;
  }

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
  renderDeviceDetailModes(device);
  updateDeltaSectionVisibility({
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
  // Do not drop drafts here: switching from device A's pane to device B's must
  // preserve A's in-progress edits per TODO `stepped-load-draft-close-handler`.
  // The draft for B (if any) is loaded via renderSteppedLoadDraft below.
  retainPendingNativeWiringEnable(deviceId);
  currentDetailDeviceId = deviceId;

  setDeviceDetailTitle(device.name);
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
  updateDeltaSectionVisibility({
    currentDetailDeviceId: deviceId,
    getDeviceById,
  });
  updateShedFieldVisibility({
    currentDetailDeviceId: deviceId,
    getDeviceById,
    isSteppedLoadControlModel,
  });

  resetDeviceDetailDiagnosticsView();
  showDeviceDetailOverlay();
};

export const closeDeviceDetail = () => {
  resetDeviceDetailDiagnosticsRequests();
  resetDeviceDetailDiagnosticsView();
  if (currentDetailDeviceId) {
    closeSteppedLoadDraft(currentDetailDeviceId);
  }
  clearPendingNativeWiringEnable();
  currentDetailDeviceId = null;
  if (deviceDetailOverlay) {
    deviceDetailOverlay.hidden = true;
  }
};

const initDeviceDetailCloseHandlers = () => {
  deviceDetailClose?.addEventListener('click', closeDeviceDetail);
  deviceDetailOverlay?.addEventListener('click', (event) => {
    if (event.target === deviceDetailOverlay) {
      closeDeviceDetail();
    }
  });
};

// md-switch only flips when the user hits the small thumb. Restore the
// legacy whole-row tap behavior by toggling the switch when its label
// area is clicked.
const initDeviceDetailSwitchRowClick = () => {
  if (!deviceDetailPanel) return;
  deviceDetailPanel.addEventListener('click', (event) => {
    const target = event.target as HTMLElement | null;
    if (!target) return;
    const row = target.closest<HTMLElement>('.md-switch-row');
    if (!row) return;
    // The user already interacted with the switch itself or an inner
    // focusable element — let the native behavior handle it.
    if (target.closest('md-switch, a, button, input, select, textarea')) return;
    const swEl = row.querySelector('md-switch') as
      | (HTMLElement & { selected: boolean; disabled: boolean })
      | null;
    if (!swEl || swEl.disabled) return;
    swEl.selected = !swEl.selected;
    swEl.dispatchEvent(new Event('change', { bubbles: true }));
  });
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

const initDeviceDetailBudgetExemptHandler = () => {
  deviceDetailBudgetExempt?.addEventListener('change', async () => {
    const deviceId = currentDetailDeviceId;
    if (!deviceId || !deviceDetailBudgetExempt) return;

    const nextChecked = deviceDetailBudgetExempt.selected;
    await writeFreshSetting<Record<string, boolean>>({
      key: BUDGET_EXEMPT_DEVICES,
      context: 'device detail',
      logMessage: 'Failed to update budget exempt device',
      toastMessage: 'Failed to update budget exempt device.',
      // Use the live budget-exempt snapshot as the fallback so a transient
      // null SDK read does not erase entries for other devices.
      fallbackValue: state.budgetExemptMap,
      readFresh: readRecordSettingStrict<boolean>,
      mutate: (currentMap) => {
        const nextMap = { ...currentMap };
        if (nextChecked) {
          nextMap[deviceId] = true;
        } else {
          delete nextMap[deviceId];
        }
        return nextMap;
      },
      commit: (nextMap) => {
        state.budgetExemptMap = nextMap;
        updateCurrentDeviceBudgetExemptSnapshot(deviceId, nextChecked);
        refreshSharedDeviceViews();
        refreshOpenDeviceDetail();
      },
      rollback: refreshOpenDeviceDetail,
    });
  });
};

const initDeviceDetailEscapeHandler = () => {
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && deviceDetailOverlay && !deviceDetailOverlay.hidden) {
      closeDeviceDetail();
    }
  });
};

const initDeviceDetailOpenHandler = () => {
  document.addEventListener('open-device-detail', (event) => {
    const custom = event as CustomEvent<{ deviceId: string }>;
    const deviceId = custom.detail?.deviceId;
    if (!deviceId) return;

    if (getDeviceById(deviceId)) {
      openDeviceDetail(deviceId);
    } else {
      pendingOpenDeviceId = deviceId;
      document.dispatchEvent(new CustomEvent('request-load-devices'));
    }
  });
};

const initDeviceDetailDiagnosticsHandler = () => {
  deviceDetailDiagnosticsDisclosure?.addEventListener('toggle', () => {
    if (!currentDetailDeviceId) return;
    if (!isDeviceDetailDiagnosticsExpanded()) {
      resetDeviceDetailDiagnosticsRequests();
      return;
    }

    const deviceId = currentDetailDeviceId;
    showDeviceDetailDiagnosticsLoading();
    void refreshDeviceDetailDiagnostics({
      deviceId,
      isCurrentDevice: () => currentDetailDeviceId === deviceId && isDeviceDetailDiagnosticsExpanded(),
    });
  });
};

const initDeviceDetailRefreshHandlers = () => {
  document.addEventListener('devices-updated', () => {
    if (pendingOpenDeviceId) {
      const deviceId = pendingOpenDeviceId;
      pendingOpenDeviceId = null;
      openDeviceDetail(deviceId);
      return;
    }
    if (!currentDetailDeviceId) return;

    const deviceId = currentDetailDeviceId;
    refreshOpenDeviceDetail();
    if (!isDeviceDetailDiagnosticsExpanded()) return;
    void refreshDeviceDetailDiagnostics({
      deviceId,
      isCurrentDevice: () => currentDetailDeviceId === deviceId && isDeviceDetailDiagnosticsExpanded(),
    });
  });

  document.addEventListener('plan-updated', () => {
    if (!currentDetailDeviceId || !isDeviceDetailDiagnosticsExpanded()) return;

    const deviceId = currentDetailDeviceId;
    void refreshDeviceDetailDiagnostics({
      deviceId,
      isCurrentDevice: () => currentDetailDeviceId === deviceId && isDeviceDetailDiagnosticsExpanded(),
    });
  });
};

export { loadEvBoostSettings, loadShedBehaviors, loadTemperatureBoostSettings };

const initOvershootSegmented = () => {
  const container = document.getElementById('device-detail-overshoot-segmented');
  if (!container || !deviceDetailShedAction) return;
  bindSegmentedToSelect({ container, select: deviceDetailShedAction });
};

export const initDeviceDetailHandlers = () => {
  initDeviceDetailCloseHandlers();
  initDeviceDetailSwitchRowClick();
  initOvershootSegmented();
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
  initDeviceDetailBudgetExemptHandler();
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
  initDeviceDetailDiagnosticsHandler();
  initDeviceDetailEscapeHandler();
  initDeviceDetailOpenHandler();
  initDeviceDetailRefreshHandlers();
};
