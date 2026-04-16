import type { SteppedLoadProfile, TargetDeviceSnapshot } from '../../../../contracts/src/types.ts';
import {
  deviceDetailDiagnosticsDisclosure,
  deviceDetailOverlay,
  deviceDetailTitle,
  deviceDetailClose,
  deviceDetailManaged,
  deviceDetailControllable,
  deviceDetailBudgetExempt,
  deviceDetailPriceOpt,
  deviceDetailControlModelRow,
  deviceDetailControlModel,
} from '../dom.ts';
import { renderDevices } from '../devices.ts';
import {
  applyLocalDeviceControlProfile,
  createDefaultSteppedLoadProfile,
  getEffectiveControlModel,
  saveDeviceControlProfiles,
} from '../deviceControlProfiles.ts';
import {
  supportsManagedDevice,
  supportsPowerDevice,
  supportsTemperatureDevice,
} from '../deviceUtils.ts';
import { logSettingsError } from '../logging.ts';
import { renderPriorities } from '../modes.ts';
import { renderPriceOptimization } from '../priceOptimization.ts';
import { resolveManagedState, state } from '../state.ts';
import { showToastError } from '../toast.ts';
import { renderDeviceDetailModes } from './modes.ts';
import { BUDGET_EXEMPT_DEVICES } from '../../../../contracts/src/settingsKeys.ts';
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
import {
  closeSteppedLoadDraft,
  initSteppedLoadDraftHandlers,
  isSteppedLoadControlModel,
  renderSteppedLoadDraft,
  resolveSavedSteppedLoadProfile,
  updateSetStepOptionLabel,
} from './steppedLoadDraft.ts';
import { readRecordSetting, writeFreshSetting } from './settingsWrite.ts';

let currentDetailDeviceId: string | null = null;
let pendingOpenDeviceId: string | null = null;

const getCurrentDetailDeviceId = () => currentDetailDeviceId;

const getDeviceById = (deviceId: string) => state.latestDevices.find((device) => device.id === deviceId) || null;

const setDeviceDetailTitle = (name: string) => {
  if (deviceDetailTitle) deviceDetailTitle.textContent = name;
};

const setDeviceDetailBudgetExemptState = (device: TargetDeviceSnapshot | null) => {
  if (!deviceDetailBudgetExempt || !device) return;
  deviceDetailBudgetExempt.checked = state.budgetExemptMap[device.id] === true || device.budgetExempt === true;
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
  const supportsTemperature = supportsTemperatureDevice(device);
  const supportsPower = supportsPowerDevice(device);
  const supportsManage = supportsManagedDevice(supportsPower, supportsTemperature);
  const isManaged = supportsManage && resolveManagedState(deviceId);

  if (deviceDetailManaged) {
    deviceDetailManaged.checked = isManaged;
    deviceDetailManaged.disabled = !supportsManage;
  }
  if (deviceDetailControllable) {
    deviceDetailControllable.checked = supportsPower && state.controllableMap[deviceId] === true;
    deviceDetailControllable.disabled = !supportsPower || !isManaged;
  }
  if (deviceDetailPriceOpt) {
    const priceConfig = state.priceOptimizationSettings[deviceId];
    deviceDetailPriceOpt.checked = supportsTemperature && isManaged && priceConfig?.enabled === true;
    deviceDetailPriceOpt.disabled = !supportsTemperature || !isManaged;
  }

  setDeviceDetailBudgetExemptState(device);
  if (deviceDetailControlModel && deviceDetailControlModelRow) {
    const effectiveControlModel = device ? getEffectiveControlModel(device) : 'temperature_target';
    deviceDetailControlModel.value = effectiveControlModel === 'stepped_load' ? 'stepped_load' : 'temperature_target';
    deviceDetailControlModel.disabled = !supportsManage;
    deviceDetailControlModelRow.hidden = !supportsManage;
  }
};

const persistDeviceControlProfile = async (deviceId: string, profile: SteppedLoadProfile | null) => {
  const previousProfiles = state.deviceControlProfiles;
  const nextProfiles = { ...previousProfiles };
  if (profile) {
    nextProfiles[deviceId] = profile;
  } else {
    delete nextProfiles[deviceId];
  }

  state.deviceControlProfiles = nextProfiles;

  try {
    await saveDeviceControlProfiles();
    applyLocalDeviceControlProfile(deviceId, profile);
    refreshSharedDeviceViews();
    notifyDevicesUpdated();
  } catch (error) {
    state.deviceControlProfiles = previousProfiles;
    if (getCurrentDetailDeviceId() === deviceId) {
      refreshOpenDeviceDetail();
    }
    throw error;
  }
};

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
  closeSteppedLoadDraft();
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
  closeSteppedLoadDraft();
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

const initDeviceDetailControllableHandler = () => {
  deviceDetailControllable?.addEventListener('change', async () => {
    const deviceId = currentDetailDeviceId;
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
      rollback: refreshCurrentDeviceControlStates,
    });
  });
};

const initDeviceDetailManagedHandler = () => {
  deviceDetailManaged?.addEventListener('change', async () => {
    const deviceId = currentDetailDeviceId;
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
        refreshSharedDeviceViews();
        refreshCurrentDeviceControlStates();
      },
      rollback: refreshCurrentDeviceControlStates,
    });
  });
};

const initDeviceDetailControlModelHandler = () => {
  deviceDetailControlModel?.addEventListener('change', async () => {
    const deviceId = currentDetailDeviceId;
    if (!deviceId || !deviceDetailControlModel) return;

    const device = getDeviceById(deviceId);
    if (!device) return;

    try {
      const nextProfile = deviceDetailControlModel.value === 'stepped_load'
        ? resolveSavedSteppedLoadProfile(device) ?? createDefaultSteppedLoadProfile(device)
        : null;
      await persistDeviceControlProfile(deviceId, nextProfile);
      refreshOpenDeviceDetail();
    } catch (error) {
      await logSettingsError('Failed to update control model', error, 'device detail');
      await showToastError(error, 'Failed to update control model.');
    }
  });
};

const initDeviceDetailBudgetExemptHandler = () => {
  deviceDetailBudgetExempt?.addEventListener('change', async () => {
    const deviceId = currentDetailDeviceId;
    if (!deviceId || !deviceDetailBudgetExempt) return;

    const nextChecked = deviceDetailBudgetExempt.checked;
    await writeFreshSetting<Record<string, boolean>>({
      key: BUDGET_EXEMPT_DEVICES,
      context: 'device detail',
      logMessage: 'Failed to update budget exempt device',
      toastMessage: 'Failed to update budget exempt device.',
      fallbackValue: {},
      readFresh: readRecordSetting<boolean>,
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

export { loadShedBehaviors };

export const initDeviceDetailHandlers = () => {
  initDeviceDetailCloseHandlers();
  initDeviceDetailManagedHandler();
  initDeviceDetailControllableHandler();
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
  initDeviceDetailDiagnosticsHandler();
  initDeviceDetailEscapeHandler();
  initDeviceDetailOpenHandler();
  initDeviceDetailRefreshHandlers();
};
