import { hideDeviceDetailLiveStatus, renderDeviceDetailLiveStatus } from './liveStatus.ts';
import { hideDeviceSmartTaskBox, renderDeviceSmartTaskBox } from './smartTaskBox.ts';
import type { SteppedLoadProfile } from '../../../../contracts/src/types.ts';
import {
  deviceDetailOverlay,
  deviceDetailManaged,
  deviceDetailControllable,
  deviceDetailPriceOpt,
  deviceDetailSurplusOpt,
  deviceDetailSurplusOptRow,
  deviceDetailControlModelRow,
  deviceDetailControlModel,
} from '../dom.ts';
import { renderDevices } from '../devices.ts';
import { refreshRecommendationSurfaces } from '../recommendations.ts';
import {
  createDefaultSteppedLoadProfile,
  isNativeSteppedLoadProfileActive,
} from '../deviceControlProfiles.ts';
import { renderPriorities } from '../modes.ts';
import { renderPriceOptimization } from '../priceOptimization.ts';
import { state } from '../state.ts';
import { renderDeviceDetailModes } from './modes.ts';
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
  surplusControlVisibleFor,
  updateSurplusSectionVisibility,
} from './solarSurplus.ts';
import {
  initDeviceDetailSurplusTrackingHandlers,
  setDeviceDetailSurplusTrackingControl,
} from './solarSurplusTracking.ts';
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
  renderSteppedLoadDraft,
  resolveSavedSteppedLoadProfile,
  updateSetStepOptionLabel,
} from './steppedLoadDraft.ts';
import { loadEvBoostSettings } from './evBoost.ts';
import { loadEvChargeTargetSettings } from './evChargeTarget.ts';
import {
  initChargingCardHandlers,
  renderChargingCardSettings,
  setDeviceDetailChargingCardState,
} from './chargingCard.ts';
import {
  initExpectedPowerHandlers,
  loadDeviceExpectedPowerOverrides,
  renderExpectedPowerField,
} from './expectedPower.ts';
import {
  clearEvCarAssociations,
  loadEvCarAssociations,
  invalidateCarOptions,
  renderCarAssociation,
} from './carAssociation.ts';
import {
  initTemperatureBoostHandlers,
  loadTemperatureBoostSettings,
  renderTemperatureBoostSettings,
} from './temperatureBoost.ts';
import { persistDeviceControlProfile as persistDeviceControlProfileWrite } from './controlProfileWrite.ts';
import {
  resetNativeWiringSetupDisclosure,
  initDeviceDetailNativeWiringHandler,
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
  resolveTargetPowerConfigForControlMode,
  syncDeviceDetailControlModeOptions,
} from './controlMode.ts';
import { resolveDeviceDetailControlState, setPowerLimitSwitch, setTemperatureGatedSwitch } from './controlState.ts';
import {
  applyDeviceDetailSectionLayout,
  autoExpandSetupWhenBare,
} from './sectionLayout.ts';
import { resolveDeviceDetailControlMode, resolveDeviceDetailKind } from '../deviceKind.ts';
import { createPendingDeviceDetailOpen, type DeviceDetailFocus } from './focus.ts';
import {
  initDeviceDetailBudgetExemptHandler,
  setDeviceDetailBudgetExemptState,
} from './budgetExempt.ts';
import { initRespectExternalOffHandler } from './respectExternalOff.ts';
import { initStartPolicyHandler, revealDeviceDetailFocus, syncDevicePolicyRows } from './startPolicy.ts';
import {
  initTemperatureControlDisabledHandler,
  syncTemperatureControlDisabledRow,
} from './temperatureControlDisabled.ts';
import { initDeviceDetailManagedControlHandlers } from './managedControl.ts';
import { BATTERY_MANAGED_HINT, BATTERY_WATCH_MANAGED_HINT, renderDeviceDetailBattery } from './batterySection.ts';
import {
  initDeviceDetailOverlayChrome,
  initDeviceDetailOverlaySubscriptions,
  noteDeviceDetailOpened,
} from './overlayHandlers.ts';
import { setDeviceDetailTitle } from './title.ts';
import { DEVICE_POWER_SUPPORT_HINT } from '../deviceControlAvailability.ts';
import { syncPriceOptRow } from './priceSourceHint.ts';

let currentDetailDeviceId: string | null = null;
const pendingDeviceDetailOpen = createPendingDeviceDetailOpen();

const getCurrentDetailDeviceId = () => currentDetailDeviceId;

const getDeviceById = (deviceId: string) => state.latestDevices.find((device) => device.id === deviceId) || null;

const refreshSharedDeviceViews = () => {
  renderDevices(state.latestDevices);
  renderPriorities(state.latestDevices);
  renderPriceOptimization(state.latestDevices);
  refreshRecommendationSurfaces();
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
  // The limiting card's statement/radiogroup split follows Power-limit
  // control, so a toggle must re-resolve it without reopening the panel.
  setDeviceDetailShedBehavior({
    deviceId: activeDeviceId,
    getDeviceById,
    updateSetStepOptionLabel,
  });
  updateShedFieldVisibility({
    currentDetailDeviceId: activeDeviceId,
    getDeviceById,
  });
  syncSwitchRowDisabledStyling();
};

const notifyDevicesUpdated = () => {
  document.dispatchEvent(new CustomEvent('devices-updated', { detail: { devices: state.latestDevices } }));
};

const showDeviceDetailOverlay = () => {
  if (deviceDetailOverlay) {
    if (deviceDetailOverlay.hidden) noteDeviceDetailOpened();
    deviceDetailOverlay.hidden = false;
  }
};

// A locked switch must read as locked: only the track outline changes when
// md-switch.disabled flips, so the row label stays full-strength and the row
// looks live. Mirror the switch's disabled state onto the row's dim class
// (`.md-switch-row--disabled`, the treatment DeadlinePlan already uses).
const syncSwitchRowDisabledStyling = () => {
  document.querySelectorAll('#device-detail-panel .md-switch-row').forEach((row) => {
    const switchEl = row.querySelector<HTMLElement & { disabled?: boolean }>('md-switch');
    row.classList.toggle('md-switch-row--disabled', switchEl?.disabled === true);
  });
};

const renderManagedControl = (
  device: ReturnType<typeof getDeviceById>,
  controlState: ReturnType<typeof resolveDeviceDetailControlState>,
): void => {
  if (deviceDetailManaged) {
    deviceDetailManaged.selected = controlState.isManaged;
    deviceDetailManaged.disabled = !controlState.canManageDevice;
  }
  const managedHint = document.getElementById('device-detail-managed-hint');
  if (managedHint) {
    managedHint.textContent = resolveManagedHint(device, controlState);
  }
};

const resolveManagedHint = (
  device: ReturnType<typeof getDeviceById>,
  controlState: ReturnType<typeof resolveDeviceDetailControlState>,
): string => {
  if (controlState.isHomeBattery) {
    return controlState.isDrivableBattery ? BATTERY_MANAGED_HINT : BATTERY_WATCH_MANAGED_HINT;
  }
  if (!controlState.supportsPower && !controlState.supportsTemperature) return DEVICE_POWER_SUPPORT_HINT;
  // An unmanaged charger's page hides its Charging and Power limiting cards
  // (chargingCard.ts), so this switch names what they hold.
  if (!controlState.isManaged && resolveDeviceDetailKind(device) === 'ev_charger') {
    return 'Turn on to set how this charger charges and how PELS limits it.';
  }
  return 'Include this device in modes and optimization plans.';
};

const setDeviceDetailControlStates = (deviceId: string) => {
  const device = getDeviceById(deviceId);
  const controlState = resolveDeviceDetailControlState(device, deviceId);

  setDeviceDetailNativeWiringState(device);
  renderManagedControl(device, controlState);
  renderDeviceDetailBattery(device);

  setPowerLimitSwitch(deviceDetailControllable, controlState, deviceId);
  const priceConfig = state.priceOptimizationSettings[deviceId];
  // Kind-inapplicable, not gated: a device with no temperature target can never
  // use price-based temperature control, so the row hides instead of promising
  // "adjust temperature" on a charger or socket.
  void syncPriceOptRow(controlState.supportsTemperature);
  setTemperatureGatedSwitch(deviceDetailPriceOpt, priceConfig?.enabled, controlState);
  setTemperatureGatedSwitch(deviceDetailSurplusOpt, priceConfig?.surplusWilling, {
    ...controlState,
    // The surplus lift reaches only a device with a power reading.
    canControlTemperature: controlState.canControlTemperature && controlState.supportsPower,
  });
  if (deviceDetailSurplusOptRow) {
    // Hidden outright rather than shown disabled, so the control never clutters
    // a home where the surplus engine has nothing to allocate.
    //
    deviceDetailSurplusOptRow.hidden
      = !(surplusControlVisibleFor(deviceId) && controlState.supportsTemperature);
  }
  // Binary sibling: the "Run on solar surplus" dump-load posture row (solarSurplus.ts
  // owns the gate — managed binary device, solar present, not temperature/stepped/EV).
  setDeviceDetailDumpLoadControl({ deviceId, getDeviceById });
  setDeviceDetailSurplusTrackingControl({ deviceId, getDeviceById });
  syncDevicePolicyRows({ deviceId, getDeviceById });
  syncTemperatureControlDisabledRow({ deviceId, getDeviceById });

  setDeviceDetailBudgetExemptState(device);
  setDeviceDetailSocState(device);
  if (deviceDetailControlModel && deviceDetailControlModelRow) {
    const effectiveControlMode = device ? resolveDeviceDetailControlMode(device) : 'default';
    const nativeSteppedLoadLocked = isNativeSteppedLoadProfileActive(device);
    syncDeviceDetailControlModeOptions(deviceDetailControlModel, device, effectiveControlMode);
    deviceDetailControlModel.value = effectiveControlMode;
    // Not gated on "Disable temperature control": picking a control model is
    // configuration, not a `target_temperature` write, and locking the select
    // is what kept a flagged device from ever being given a step ladder.
    deviceDetailControlModel.disabled = !controlState.canManageDevice
      || nativeSteppedLoadLocked;
    deviceDetailControlModelRow.hidden = !controlState.canManageDevice;
  }

  setDeviceDetailChargingCardState(device, controlState);
  autoExpandSetupWhenBare({
    deviceId,
    device,
    isManaged: controlState.isManaged,
  });
};

/**
 * The single write boundary for `device_control_profiles`.
 *
 * Every caller passes a profile it believes is good — the editor's normalized
 * draft, or the ladder generated when the owner switches to stepped control —
 * so the guard here is about the class of bug rather than any caller in
 * particular: nothing may persist a ladder with no step above 0 W, because
 * PELS would then own a device it can pause and never resume. Refusing the
 * write leaves the previous profile in place; the caller reports the failure.
 */
const persistDeviceControlProfile = (
  deviceId: string,
  profile: SteppedLoadProfile | null,
): Promise<boolean> => persistDeviceControlProfileWrite({
  deviceId,
  profile,
  onCommitted: () => {
    refreshSharedDeviceViews();
    notifyDevicesUpdated();
  },
  onRolledBack: (rolledBackDeviceId) => {
    if (currentDetailDeviceId === rolledBackDeviceId) refreshOpenDeviceDetail();
  },
});

const refreshOpenDeviceDetail = () => {
  if (!currentDetailDeviceId) return;

  const device = getDeviceById(currentDetailDeviceId);
  if (!device) {
    closeDeviceDetail();
    return;
  }

  setDeviceDetailTitle(device.name);
  applyDeviceDetailSectionLayout(device);
  void renderDeviceDetailLiveStatus(currentDetailDeviceId);
  renderDeviceSmartTaskBox(currentDetailDeviceId);
  setDeviceDetailControlStates(currentDetailDeviceId);
  setDeviceDetailShedBehavior({
    deviceId: currentDetailDeviceId,
    getDeviceById,
    updateSetStepOptionLabel,
  });
  renderSteppedLoadDraft(device);
  renderTargetPowerConfig(device);
  renderExpectedPowerField(device);
  renderTemperatureBoostSettings(device);
  renderChargingCardSettings(device);
  renderCarAssociation(device);
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
  });
  syncSwitchRowDisabledStyling();
};

export const openDeviceDetail = (deviceId: string) => {
  const device = getDeviceById(deviceId);
  if (!device) return;

  resetDeviceDetailDiagnosticsRequests();
  resetDeviceDetailActivityLogRequests();
  // Do not drop drafts here: switching from device A's pane to device B's must
  // preserve A's in-progress edits — only `closeSteppedLoadDraft`, called from
  // `closeDeviceDetail` when the pane itself closes, drops a device's draft.
  // The draft for B (if any) is loaded via renderSteppedLoadDraft below.
  currentDetailDeviceId = deviceId;

  setDeviceDetailTitle(device.name);
  applyDeviceDetailSectionLayout(device);
  void renderDeviceDetailLiveStatus(deviceId);
  renderDeviceSmartTaskBox(deviceId);
  setDeviceDetailControlStates(deviceId);
  setDeviceDetailShedBehavior({
    deviceId,
    getDeviceById,
    updateSetStepOptionLabel,
  });
  renderSteppedLoadDraft(device);
  renderTargetPowerConfig(device);
  renderExpectedPowerField(device);
  renderTemperatureBoostSettings(device);
  renderChargingCardSettings(device);
  invalidateCarOptions();
  renderCarAssociation(device);
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
  });

  syncSwitchRowDisabledStyling();

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
  resetNativeWiringSetupDisclosure();
  hideDeviceDetailLiveStatus();
  hideDeviceSmartTaskBox();
  currentDetailDeviceId = null;
  if (deviceDetailOverlay) {
    deviceDetailOverlay.hidden = true;
  }
  // A page under the overlay that states what this device's settings do (the
  // New smart task flow's after-task line) repaints once they may have changed.
  document.dispatchEvent(new CustomEvent('device-detail-closed'));
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

export {
  clearEvCarAssociations,
  loadDeviceExpectedPowerOverrides,
  loadEvBoostSettings,
  loadEvChargeTargetSettings,
  loadEvCarAssociations,
  loadShedBehaviors,
  loadTemperatureBoostSettings,
};

/** Open a device's page and land on the setting a deep link names. */
export const openDeviceDetailAt = (deviceId: string, focus: DeviceDetailFocus): void => {
  openDeviceDetail(deviceId);
  if (currentDetailDeviceId === deviceId) revealDeviceDetailFocus(focus);
};

export const initDeviceDetailHandlers = () => {
  const overlayContext = {
    getCurrentDetailDeviceId,
    getDeviceById,
    openDeviceDetailAt,
    closeDeviceDetail,
    refreshOpenDeviceDetail,
    pendingDeviceDetailOpen,
  };
  initDeviceDetailOverlayChrome(overlayContext);
  initDeviceDetailNativeWiringHandler({
    getCurrentDetailDeviceId,
    getDeviceById,
    refreshCurrentDeviceControlStates,
    refreshSharedDeviceViews,
  });
  initDeviceDetailManagedControlHandlers(
    getCurrentDetailDeviceId,
    refreshCurrentDeviceControlStates,
    refreshOpenDeviceDetail,
    refreshSharedDeviceViews,
  );
  // Reorder carries `data-settings-target="modes"`, which the shell's click
  // delegation opens; the device page closes so the order is in view.
  document.getElementById('device-detail-battery-priority-reorder')?.addEventListener('click', () => {
    closeDeviceDetail();
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
  initDeviceDetailSurplusTrackingHandlers({
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
  initStartPolicyHandler({ getCurrentDetailDeviceId, refreshSharedDeviceViews, refreshOpenDeviceDetail });
  initTemperatureControlDisabledHandler({
    getCurrentDetailDeviceId,
    getDeviceById,
    refreshSharedDeviceViews,
    refreshOpenDeviceDetail,
  });
  initDeviceDetailShedHandlers({
    getCurrentDetailDeviceId,
    getDeviceById,
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
  initChargingCardHandlers({
    getCurrentDetailDeviceId,
    getDeviceById,
    refreshOpenDeviceDetail,
  });
  initExpectedPowerHandlers({
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
