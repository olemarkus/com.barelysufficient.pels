/* eslint-disable max-lines */
import {
  getSteppedLoadLowestActiveStep,
  normalizeSteppedLoadProfile,
  sortSteppedLoadSteps,
} from '../../../contracts/src/deviceControlProfiles.ts';
import type { SteppedLoadProfile, TargetDeviceSnapshot } from '../../../contracts/src/types.ts';
import {
  deviceDetailDiagnosticsDisclosure,
  deviceDetailOverlay,
  deviceDetailTitle,
  deviceDetailClose,
  deviceDetailManaged,
  deviceDetailControllable,
  deviceDetailPriceOpt,
  deviceDetailControlModelRow,
  deviceDetailControlModel,
  deviceDetailDeltaSection,
  deviceDetailCheapDelta,
  deviceDetailExpensiveDelta,
  deviceDetailShedAction,
  deviceDetailShedTempRow,
  deviceDetailShedTemp,
  deviceDetailShedStepRow,
  deviceDetailShedStep,
  deviceDetailSteppedSection,
  deviceDetailSteppedSteps,
  deviceDetailSteppedAddStep,
  deviceDetailSteppedSave,
  deviceDetailSteppedReset,
} from './dom.ts';
import { getSetting, setSetting } from './homey.ts';
import { resolveManagedState, state, defaultPriceOptimizationConfig } from './state.ts';
import { renderDevices } from './devices.ts';
import { renderPriorities } from './modes.ts';
import { renderPriceOptimization, savePriceOptimizationSettings } from './priceOptimization.ts';
import { showToastError } from './toast.ts';
import { logSettingsError } from './logging.ts';
import { renderDeviceDetailModes } from './deviceDetailModes.ts';
import {
  applyLocalDeviceControlProfile,
  createDefaultSteppedLoadProfile,
  getEffectiveControlModel,
  getStoredDeviceControlProfile,
  saveDeviceControlProfiles,
} from './deviceControlProfiles.ts';
import {
  supportsManagedDevice,
  supportsPowerDevice,
  supportsTemperatureDevice,
} from './deviceUtils.ts';
import {
  AIRTREATMENT_SHED_FLOOR_C,
  NON_ONOFF_TEMPERATURE_SHED_FLOOR_C,
} from '../../../shared-domain/src/utils/airtreatmentConstants.ts';
import {
  OVERSHOOT_BEHAVIORS,
} from '../../../contracts/src/settingsKeys.ts';
import {
  computeDefaultAirtreatmentShedTemperature,
  normalizeShedTemperature,
} from '../../../shared-domain/src/utils/airtreatmentShedTemperature.ts';
import {
  isDeviceDetailDiagnosticsExpanded,
  refreshDeviceDetailDiagnostics,
  resetDeviceDetailDiagnosticsView,
  resetDeviceDetailDiagnosticsRequests,
  showDeviceDetailDiagnosticsLoading,
} from './deviceDetailDiagnostics.ts';

let currentDetailDeviceId: string | null = null;
let currentSteppedLoadDraft: SteppedLoadProfile | null = null;
const DEFAULT_SET_STEP_OPTION_LABEL = 'Set to step';

type ShedAction = 'turn_off' | 'set_temperature' | 'set_step';

const getDeviceById = (deviceId: string) => state.latestDevices.find((device) => device.id === deviceId) || null;

const isSteppedLoadControlModel = (device: TargetDeviceSnapshot | null): boolean => (
  Boolean(device && getEffectiveControlModel(device) === 'stepped_load')
);

const resolveSavedSteppedLoadProfile = (device: TargetDeviceSnapshot): SteppedLoadProfile | null => {
  const stored = getStoredDeviceControlProfile(device.id);
  if (stored?.model === 'stepped_load') return stored;
  return device.steppedLoadProfile?.model === 'stepped_load' ? device.steppedLoadProfile : null;
};

const getSetStepOption = (): HTMLOptionElement | null => (
  deviceDetailShedAction?.querySelector<HTMLOptionElement>('option[value="set_step"]') ?? null
);

const isTemperatureDeviceWithoutOnOff = (device: TargetDeviceSnapshot | null): boolean => (
  Boolean(
    device
    && supportsTemperatureDevice(device)
    && !device.capabilities?.includes('onoff'),
  )
);

const resolveTemperatureShedFloor = (device: TargetDeviceSnapshot | null): number => {
  const classKey = (device?.deviceClass || '').trim().toLowerCase();
  return classKey === 'airtreatment' ? AIRTREATMENT_SHED_FLOOR_C : NON_ONOFF_TEMPERATURE_SHED_FLOOR_C;
};

const updateShedActionOptions = (params: {
  canConfigure: boolean;
  forceTemperatureOnly: boolean;
  supportsTemperature: boolean;
  supportsStep: boolean;
}): void => {
  if (!deviceDetailShedAction) return;
  const {
    canConfigure,
    forceTemperatureOnly,
    supportsTemperature,
    supportsStep,
  } = params;
  const turnOffOption = deviceDetailShedAction.querySelector<HTMLOptionElement>('option[value="turn_off"]');
  const setTempOption = deviceDetailShedAction.querySelector<HTMLOptionElement>('option[value="set_temperature"]');
  const setStepOption = deviceDetailShedAction.querySelector<HTMLOptionElement>('option[value="set_step"]');
  if (turnOffOption) {
    turnOffOption.disabled = !canConfigure || forceTemperatureOnly;
    turnOffOption.hidden = forceTemperatureOnly;
  }
  if (setTempOption) {
    setTempOption.disabled = !canConfigure;
    setTempOption.hidden = !supportsTemperature;
  }
  if (setStepOption) {
    setStepOption.disabled = !canConfigure || !supportsStep;
    setStepOption.hidden = !supportsStep;
  }
  deviceDetailShedAction.disabled = !canConfigure || forceTemperatureOnly;
};

const isShedActionOptionVisible = (action: ShedAction): boolean => {
  if (!deviceDetailShedAction) return false;
  const option = deviceDetailShedAction.querySelector<HTMLOptionElement>(`option[value="${action}"]`);
  return Boolean(option && !option.hidden);
};

const resolveShedActionValue = (params: {
  canConfigure: boolean;
  forceTemperatureOnly: boolean;
  configuredAction: ShedAction | undefined;
}): ShedAction => {
  const { canConfigure, forceTemperatureOnly, configuredAction } = params;
  if (!canConfigure) return 'turn_off';
  if (forceTemperatureOnly) return 'set_temperature';
  if (configuredAction === 'set_step') return 'set_step';
  return configuredAction || 'turn_off';
};

const resolveShedTemperatureValue = (params: {
  canConfigure: boolean;
  forceTemperatureOnly: boolean;
  configuredTemperature: number | undefined;
  fallbackTemperature: number;
}): string => {
  const { canConfigure, forceTemperatureOnly, configuredTemperature, fallbackTemperature } = params;
  if (!canConfigure) return '';
  if (typeof configuredTemperature === 'number') return configuredTemperature.toString();
  if (forceTemperatureOnly) return fallbackTemperature.toString();
  return '';
};

const setDeviceDetailTitle = (name: string) => {
  if (deviceDetailTitle) deviceDetailTitle.textContent = name;
};

const attachDraftSyncOnChange = (...inputs: HTMLInputElement[]) => {
  inputs.forEach((input) => {
    input.addEventListener('change', () => {
      syncSteppedLoadDraftState();
    });
  });
};

const getDraftProfileFromCurrentDevice = (device: TargetDeviceSnapshot): SteppedLoadProfile => (
  currentSteppedLoadDraft
  ?? resolveSavedSteppedLoadProfile(device)
  ?? createDefaultSteppedLoadProfile(device)
);

const syncSteppedLoadDraftState = () => {
  const deviceId = currentDetailDeviceId;
  if (!deviceId) return;
  const device = getDeviceById(deviceId);
  if (!device) return;
  const profile = collectSteppedLoadDraftFromDom()
    ?? currentSteppedLoadDraft
    ?? getDraftProfileFromCurrentDevice(device);
  currentSteppedLoadDraft = profile;
  updateSetStepOptionLabel(device, profile);
};

const updateSetStepOptionLabel = (
  device: TargetDeviceSnapshot | null,
  profileOverride?: SteppedLoadProfile | null,
) => {
  const setStepOption = getSetStepOption();
  if (!setStepOption) return;
  if (!device || !isSteppedLoadControlModel(device)) {
    setStepOption.textContent = DEFAULT_SET_STEP_OPTION_LABEL;
    return;
  }
  const profile = profileOverride
    ?? currentSteppedLoadDraft
    ?? resolveSavedSteppedLoadProfile(device);
  const lowestActiveStepId = profile ? getSteppedLoadLowestActiveStep(profile)?.id : null;
  setStepOption.textContent = lowestActiveStepId
    ? `Set to step "${lowestActiveStepId}"`
    : DEFAULT_SET_STEP_OPTION_LABEL;
};

const buildSteppedLoadStepRow = (step: SteppedLoadProfile['steps'][number]): HTMLElement => {
  const row = document.createElement('div');
  row.className = 'device-row detail-stepped-row';
  row.dataset.stepRow = 'true';

  const idInput = document.createElement('input');
  idInput.type = 'text';
  idInput.value = step.id;
  idInput.dataset.stepField = 'id';
  idInput.placeholder = 'step';
  idInput.setAttribute('aria-label', 'Step id');

  const planningInput = document.createElement('input');
  planningInput.type = 'number';
  planningInput.step = '50';
  planningInput.min = '0';
  planningInput.value = String(step.planningPowerW);
  planningInput.dataset.stepField = 'planningPowerW';
  planningInput.placeholder = '0';
  planningInput.setAttribute('aria-label', 'Planning power in watts');

  attachDraftSyncOnChange(idInput, planningInput);

  const removeButton = document.createElement('button');
  removeButton.type = 'button';
  removeButton.className = 'btn ghost';
  removeButton.textContent = 'Remove';
  removeButton.setAttribute('aria-label', `Remove step ${step.id}`);
  removeButton.addEventListener('click', () => {
    row.remove();
    syncSteppedLoadDraftState();
  });

  row.append(idInput, planningInput, removeButton);
  return row;
};

function collectSteppedLoadDraftFromDom(): SteppedLoadProfile | null {
  if (!deviceDetailSteppedSteps) return null;
  const rows = Array.from(deviceDetailSteppedSteps.querySelectorAll<HTMLElement>('[data-step-row="true"]'));
  const steps = rows.map((row) => {
    const readValue = (field: string) => (
      row.querySelector<HTMLInputElement>(`[data-step-field="${field}"]`)?.value?.trim() ?? ''
    );
    return {
      id: readValue('id'),
      planningPowerW: Number.parseFloat(readValue('planningPowerW')),
    };
  });

  return normalizeSteppedLoadProfile({
    model: 'stepped_load',
    steps,
  }) ?? null;
}

const renderSteppedLoadDraft = (device: TargetDeviceSnapshot) => {
  if (!deviceDetailSteppedSection || !deviceDetailSteppedSteps) return;
  const steppedEnabled = isSteppedLoadControlModel(device);
  deviceDetailSteppedSection.hidden = !steppedEnabled;
  if (!steppedEnabled) {
    currentSteppedLoadDraft = null;
    deviceDetailSteppedSteps.replaceChildren();
    updateSetStepOptionLabel(device, null);
    return;
  }

  const profile = getDraftProfileFromCurrentDevice(device);
  currentSteppedLoadDraft = profile;
  updateSetStepOptionLabel(device, profile);
  const rows = sortSteppedLoadSteps(profile.steps).map((step) => buildSteppedLoadStepRow(step));
  deviceDetailSteppedSteps.replaceChildren(...rows);
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

  const priceConfig = state.priceOptimizationSettings[deviceId];
  if (deviceDetailPriceOpt) {
    deviceDetailPriceOpt.checked = supportsTemperature && isManaged && priceConfig?.enabled === true;
    deviceDetailPriceOpt.disabled = !supportsTemperature || !isManaged;
  }
  if (deviceDetailControlModel && deviceDetailControlModelRow) {
    const effectiveControlModel = device ? getEffectiveControlModel(device) : 'temperature_target';
    deviceDetailControlModel.value = effectiveControlModel === 'stepped_load' ? 'stepped_load' : 'temperature_target';
    deviceDetailControlModel.disabled = !supportsManage;
    deviceDetailControlModelRow.hidden = !supportsManage;
  }
};

const setDeviceDetailShedBehavior = (deviceId: string) => {
  const device = getDeviceById(deviceId);
  updateSetStepOptionLabel(device);
  const supportsTemperature = supportsTemperatureDevice(device);
  const supportsPower = supportsPowerDevice(device);
  const supportsStep = isSteppedLoadControlModel(device);
  const canConfigure = supportsPower && (supportsTemperature || supportsStep);
  const forceTemperatureOnly = canConfigure && !supportsStep && isTemperatureDeviceWithoutOnOff(device);
  const shedConfig = state.shedBehaviors[deviceId];
  updateShedActionOptions({ canConfigure, forceTemperatureOnly, supportsTemperature, supportsStep });
  if (deviceDetailShedAction) {
    const nextAction = resolveShedActionValue({
      canConfigure,
      forceTemperatureOnly,
      configuredAction: shedConfig?.action,
    });
    deviceDetailShedAction.value = nextAction === 'set_step' && !supportsStep ? 'turn_off' : nextAction;
  }
  if (deviceDetailShedStep) {
    deviceDetailShedStep.innerHTML = '';
    deviceDetailShedStep.disabled = true;
  }
  if (deviceDetailShedTemp) {
    const fallback = getShedDefaultTemp(deviceId);
    const nextTempValue = resolveShedTemperatureValue({
      canConfigure,
      forceTemperatureOnly,
      configuredTemperature: shedConfig?.temperature,
      fallbackTemperature: fallback,
    });
    deviceDetailShedTemp.value = nextTempValue;
    deviceDetailShedTemp.disabled = !canConfigure;
  }
};

const setDeviceDetailDeltaValues = (deviceId: string) => {
  const priceConfig = state.priceOptimizationSettings[deviceId];
  if (deviceDetailCheapDelta) {
    deviceDetailCheapDelta.value = (priceConfig?.cheapDelta ?? 5).toString();
  }
  if (deviceDetailExpensiveDelta) {
    deviceDetailExpensiveDelta.value = (priceConfig?.expensiveDelta ?? -5).toString();
  }
};

const showDeviceDetailOverlay = () => {
  if (deviceDetailOverlay) {
    deviceDetailOverlay.hidden = false;
  }
};

const updateDeltaSectionVisibility = () => {
  if (!deviceDetailDeltaSection || !deviceDetailPriceOpt) return;
  const device = currentDetailDeviceId ? getDeviceById(currentDetailDeviceId) : null;
  if (!supportsTemperatureDevice(device)) {
    deviceDetailDeltaSection.style.display = 'none';
    return;
  }
  const isManaged = currentDetailDeviceId ? resolveManagedState(currentDetailDeviceId) : false;
  deviceDetailDeltaSection.style.display = deviceDetailPriceOpt.checked && isManaged ? 'block' : 'none';
};

const getShedDefaultTemp = (deviceId: string | null): number => {
  if (!deviceId) return 10;
  const device = state.latestDevices.find((d) => d.id === deviceId);
  const modeTarget = state.modeTargets[state.activeMode]?.[deviceId]
    ?? state.modeTargets[state.editingMode]?.[deviceId];
  const normalizedModeTarget = typeof modeTarget === 'number' ? modeTarget : null;
  const currentTarget = typeof device?.targets?.[0]?.value === 'number'
    ? device.targets[0].value
    : null;

  if (isTemperatureDeviceWithoutOnOff(device)) {
    return computeDefaultAirtreatmentShedTemperature({
      modeTarget: normalizedModeTarget,
      currentTarget,
      minFloorC: resolveTemperatureShedFloor(device),
    });
  }

  if (normalizedModeTarget !== null) return normalizedModeTarget;
  if (currentTarget !== null) return currentTarget;
  return 10;
};

const parseShedTemperatureInput = (): number | null => {
  const parsedTemp = parseFloat(deviceDetailShedTemp?.value || '');
  if (!Number.isFinite(parsedTemp)) return null;
  if (parsedTemp < -20 || parsedTemp > 50) return null;
  return parsedTemp;
};

const resolveTemperatureShedBehavior = (deviceId: string): {
  behavior: { action: ShedAction; temperature?: number };
  updateTempInput?: number;
} => {
  const device = getDeviceById(deviceId);
  const forceTemperatureOnly = isTemperatureDeviceWithoutOnOff(device);
  const action: ShedAction = forceTemperatureOnly || deviceDetailShedAction?.value === 'set_temperature'
    ? 'set_temperature'
    : 'turn_off';
  if (action === 'turn_off') {
    return { behavior: { action: 'turn_off' } };
  }
  const parsedTemp = parseShedTemperatureInput();
  let temperature = parsedTemp ?? state.shedBehaviors[deviceId]?.temperature ?? getShedDefaultTemp(deviceId);
  if (forceTemperatureOnly) {
    temperature = Math.max(resolveTemperatureShedFloor(device), normalizeShedTemperature(temperature));
  }
  const shouldUpdateTempInput = parsedTemp === null || (forceTemperatureOnly && parsedTemp !== temperature);
  return {
    behavior: { action: 'set_temperature', temperature },
    updateTempInput: shouldUpdateTempInput ? temperature : undefined,
  };
};

const resolveSteppedLoadShedBehavior = (deviceId: string): {
  behavior: { action: ShedAction; stepId?: string };
} => {
  const device = getDeviceById(deviceId);
  if (!device || !isSteppedLoadControlModel(device)) {
    return { behavior: { action: 'turn_off' } };
  }
  const action: ShedAction = deviceDetailShedAction?.value === 'set_step' ? 'set_step' : 'turn_off';
  if (action === 'turn_off') {
    return { behavior: { action: 'turn_off' } };
  }
  return { behavior: { action: 'set_step' } };
};

const updateShedTempVisibility = () => {
  if (!deviceDetailShedAction || !deviceDetailShedTempRow) return;
  const device = currentDetailDeviceId ? getDeviceById(currentDetailDeviceId) : null;
  const selectedAction = resolveVisibleShedAction(device);
  if (selectedAction !== 'set_temperature') {
    deviceDetailShedTempRow.hidden = true;
    if (deviceDetailShedTemp) {
      deviceDetailShedTemp.disabled = true;
    }
    return;
  }
  deviceDetailShedTempRow.hidden = false;
  if (deviceDetailShedTemp) {
    deviceDetailShedTemp.disabled = false;
    if (!deviceDetailShedTemp.value) {
      const fallback = getShedDefaultTemp(currentDetailDeviceId);
      deviceDetailShedTemp.value = fallback.toString();
    }
  }
};

const updateShedStepVisibility = () => {
  if (!deviceDetailShedStepRow) return;
  deviceDetailShedStepRow.hidden = true;
};

const resolveVisibleShedAction = (
  device: TargetDeviceSnapshot | null,
): ShedAction | null => {
  if (!deviceDetailShedAction || !device || !supportsPowerDevice(device)) return null;
  if (
    isTemperatureDeviceWithoutOnOff(device)
    && isShedActionOptionVisible('set_temperature')
  ) {
    return 'set_temperature';
  }
  if (
    deviceDetailShedAction.value === 'set_step'
    && isSteppedLoadControlModel(device)
    && isShedActionOptionVisible('set_step')
  ) {
    return 'set_step';
  }
  if (
    deviceDetailShedAction.value === 'set_temperature'
    && supportsTemperatureDevice(device)
    && isShedActionOptionVisible('set_temperature')
  ) {
    return 'set_temperature';
  }
  return null;
};

const updateShedFieldVisibility = () => {
  updateShedTempVisibility();
  updateShedStepVisibility();
};

const saveShedBehavior = async () => {
  const deviceId = currentDetailDeviceId;
  if (!deviceId) return;
  const device = getDeviceById(deviceId);
  if (!supportsPowerDevice(device)) {
    state.shedBehaviors[deviceId] = { action: 'turn_off' };
    await setSetting(OVERSHOOT_BEHAVIORS, state.shedBehaviors);
    return;
  }
  if (isSteppedLoadControlModel(device) && deviceDetailShedAction?.value === 'set_step') {
    const { behavior } = resolveSteppedLoadShedBehavior(deviceId);
    state.shedBehaviors[deviceId] = behavior;
    await setSetting(OVERSHOOT_BEHAVIORS, state.shedBehaviors);
    return;
  }
  if (!supportsTemperatureDevice(device)) {
    state.shedBehaviors[deviceId] = { action: 'turn_off' };
    await setSetting(OVERSHOOT_BEHAVIORS, state.shedBehaviors);
    return;
  }
  const { behavior, updateTempInput } = resolveTemperatureShedBehavior(deviceId);
  state.shedBehaviors[deviceId] = behavior;
  if (typeof updateTempInput === 'number' && deviceDetailShedTemp) {
    deviceDetailShedTemp.value = updateTempInput.toString();
  }
  await setSetting(OVERSHOOT_BEHAVIORS, state.shedBehaviors);
};

const notifyDevicesUpdated = () => {
  document.dispatchEvent(new CustomEvent('devices-updated', { detail: { devices: state.latestDevices } }));
};

const persistDeviceControlProfile = async (deviceId: string, profile: SteppedLoadProfile | null) => {
  if (profile) {
    state.deviceControlProfiles[deviceId] = profile;
  } else {
    delete state.deviceControlProfiles[deviceId];
  }
  await saveDeviceControlProfiles();
  applyLocalDeviceControlProfile(deviceId, profile);
  renderDevices(state.latestDevices);
  renderPriorities(state.latestDevices);
  renderPriceOptimization(state.latestDevices);
  notifyDevicesUpdated();
};

const saveSteppedLoadProfile = async () => {
  const deviceId = currentDetailDeviceId;
  if (!deviceId) return;
  const device = getDeviceById(deviceId);
  if (!device) return;
  const profile = collectSteppedLoadDraftFromDom();
  if (!profile) {
    throw new Error(
      'Complete the stepped-load profile before saving. '
      + 'Each step needs a unique id and valid planning power.',
    );
  }
  currentSteppedLoadDraft = profile;
  const existingShedBehavior = state.shedBehaviors[deviceId];
  if (existingShedBehavior?.action === 'set_step') {
    const lowestActiveStepId = getSteppedLoadLowestActiveStep(profile)?.id;
    if (lowestActiveStepId) {
      state.shedBehaviors[deviceId] = { action: 'set_step' };
    } else {
      state.shedBehaviors[deviceId] = { action: 'turn_off' };
    }
    await setSetting(OVERSHOOT_BEHAVIORS, state.shedBehaviors);
  }
  await persistDeviceControlProfile(deviceId, profile);
  refreshOpenDeviceDetail();
};

const appendDraftSteppedLoadStep = () => {
  const deviceId = currentDetailDeviceId;
  if (!deviceId) return;
  const device = getDeviceById(deviceId);
  if (!device) return;
  const profile = collectSteppedLoadDraftFromDom()
    ?? currentSteppedLoadDraft
    ?? getDraftProfileFromCurrentDevice(device);
  const existingIds = new Set(profile.steps.map((step) => step.id));
  let nextIndex = profile.steps.length + 1;
  let nextId = `step_${nextIndex}`;
  while (existingIds.has(nextId)) {
    nextIndex += 1;
    nextId = `step_${nextIndex}`;
  }
  const lastPower = profile.steps[profile.steps.length - 1]?.planningPowerW ?? 0;
  currentSteppedLoadDraft = {
    ...profile,
    steps: [...profile.steps, {
      id: nextId,
      planningPowerW: lastPower,
    }],
  };
  renderSteppedLoadDraft(device);
};

const resetSteppedLoadDraft = () => {
  const deviceId = currentDetailDeviceId;
  if (!deviceId) return;
  const device = getDeviceById(deviceId);
  if (!device) return;
  currentSteppedLoadDraft = resolveSavedSteppedLoadProfile(device) ?? createDefaultSteppedLoadProfile(device);
  renderSteppedLoadDraft(device);
};

export const loadShedBehaviors = async () => {
  try {
    const behaviors = await getSetting(OVERSHOOT_BEHAVIORS);
    state.shedBehaviors = behaviors && typeof behaviors === 'object'
      ? behaviors as Record<string, { action: ShedAction; temperature?: number; stepId?: string }>
      : {};
  } catch (error) {
    await logSettingsError('Failed to load shed behaviors', error, 'loadShedBehaviors');
  }
};

export const openDeviceDetail = (deviceId: string) => {
  const device = getDeviceById(deviceId);
  if (!device) return;

  resetDeviceDetailDiagnosticsRequests();
  currentDetailDeviceId = deviceId;
  currentSteppedLoadDraft = null;

  setDeviceDetailTitle(device.name);
  setDeviceDetailControlStates(deviceId);
  setDeviceDetailShedBehavior(deviceId);
  renderSteppedLoadDraft(device);

  renderDeviceDetailModes(device);

  setDeviceDetailDeltaValues(deviceId);

  updateDeltaSectionVisibility();
  updateShedFieldVisibility();

  resetDeviceDetailDiagnosticsView();
  showDeviceDetailOverlay();
};

const closeDeviceDetail = () => {
  resetDeviceDetailDiagnosticsRequests();
  resetDeviceDetailDiagnosticsView();
  currentDetailDeviceId = null;
  currentSteppedLoadDraft = null;
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
    if (!currentDetailDeviceId) return;
    state.controllableMap[currentDetailDeviceId] = deviceDetailControllable.checked;
    try {
      await setSetting('controllable_devices', state.controllableMap);
      renderDevices(state.latestDevices);
    } catch (error) {
      await logSettingsError('Failed to update controllable device', error, 'device detail');
      await showToastError(error, 'Failed to update controllable device.');
    }
  });
};

const initDeviceDetailManagedHandler = () => {
  deviceDetailManaged?.addEventListener('change', async () => {
    if (!currentDetailDeviceId) return;
    state.managedMap[currentDetailDeviceId] = deviceDetailManaged.checked;
    try {
      await setSetting('managed_devices', state.managedMap);
      renderDevices(state.latestDevices);
      renderPriorities(state.latestDevices);
      renderPriceOptimization(state.latestDevices);
      setDeviceDetailControlStates(currentDetailDeviceId);
      updateDeltaSectionVisibility();
    } catch (error) {
      await logSettingsError('Failed to update managed device', error, 'device detail');
      await showToastError(error, 'Failed to update managed device.');
    }
  });
};

const initDeviceDetailControlModelHandler = () => {
  deviceDetailControlModel?.addEventListener('change', async () => {
    const deviceId = currentDetailDeviceId;
    if (!deviceId) return;
    const device = getDeviceById(deviceId);
    if (!device) return;
    try {
      if (deviceDetailControlModel.value === 'stepped_load') {
        const profile = resolveSavedSteppedLoadProfile(device) ?? createDefaultSteppedLoadProfile(device);
        currentSteppedLoadDraft = profile;
        await persistDeviceControlProfile(deviceId, profile);
      } else {
        currentSteppedLoadDraft = null;
        await persistDeviceControlProfile(deviceId, null);
      }
      refreshOpenDeviceDetail();
    } catch (error) {
      await logSettingsError('Failed to update control model', error, 'device detail');
      await showToastError(error, 'Failed to update control model.');
    }
  });
};

const ensurePriceOptimizationConfig = (deviceId: string) => {
  if (!state.priceOptimizationSettings[deviceId]) {
    state.priceOptimizationSettings[deviceId] = { ...defaultPriceOptimizationConfig };
  }
  return state.priceOptimizationSettings[deviceId];
};

const parsePriceDeltaInput = (value: string | undefined, fallback: number): number => {
  const parsed = parseFloat(value || '');
  if (!Number.isFinite(parsed)) return fallback;
  if (parsed < -20 || parsed > 20) return fallback;
  return parsed;
};

const readPriceOptInputs = (): { enabled: boolean; cheapDelta: number; expensiveDelta: number } => ({
  enabled: deviceDetailPriceOpt?.checked || false,
  cheapDelta: parsePriceDeltaInput(deviceDetailCheapDelta?.value, 5),
  expensiveDelta: parsePriceDeltaInput(deviceDetailExpensiveDelta?.value, -5),
});

const initDeviceDetailPriceOptHandlers = () => {
  const autoSavePriceOpt = async () => {
    const deviceId = currentDetailDeviceId;
    if (!deviceId) return;
    const device = getDeviceById(deviceId);
    if (!supportsTemperatureDevice(device)) return;
    const { enabled, cheapDelta, expensiveDelta } = readPriceOptInputs();
    const config = ensurePriceOptimizationConfig(deviceId);
    config.enabled = enabled;
    config.cheapDelta = cheapDelta;
    config.expensiveDelta = expensiveDelta;
    try {
      await savePriceOptimizationSettings();
      renderDevices(state.latestDevices);
      renderPriceOptimization(state.latestDevices);
      updateDeltaSectionVisibility();
    } catch (error) {
      await logSettingsError('Failed to save price optimization settings', error, 'device detail');
      await showToastError(error, 'Failed to save price optimization settings.');
    }
  };

  deviceDetailPriceOpt?.addEventListener('change', autoSavePriceOpt);
  deviceDetailCheapDelta?.addEventListener('change', autoSavePriceOpt);
  deviceDetailExpensiveDelta?.addEventListener('change', autoSavePriceOpt);
};

const initDeviceDetailShedHandlers = () => {
  const autoSaveShedBehavior = async () => {
    updateShedFieldVisibility();
    try {
      await saveShedBehavior();
    } catch (error) {
      await logSettingsError('Failed to save shed behavior', error, 'device detail');
      await showToastError(error, 'Failed to save shed behavior.');
    }
  };
  deviceDetailShedAction?.addEventListener('change', autoSaveShedBehavior);
  deviceDetailShedTemp?.addEventListener('change', autoSaveShedBehavior);
  deviceDetailShedStep?.addEventListener('change', autoSaveShedBehavior);
};

const initDeviceDetailSteppedHandlers = () => {
  deviceDetailSteppedAddStep?.addEventListener('click', () => {
    appendDraftSteppedLoadStep();
  });
  deviceDetailSteppedReset?.addEventListener('click', () => {
    resetSteppedLoadDraft();
  });
  deviceDetailSteppedSave?.addEventListener('click', async () => {
    try {
      await saveSteppedLoadProfile();
    } catch (error) {
      await logSettingsError('Failed to save stepped-load profile', error, 'device detail');
      await showToastError(error, 'Failed to save stepped-load profile.');
    }
  });
};

const initDeviceDetailEscapeHandler = () => {
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && deviceDetailOverlay && !deviceDetailOverlay.hidden) {
      closeDeviceDetail();
    }
  });
};

let pendingOpenDeviceId: string | null = null;

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

const refreshOpenDeviceDetail = () => {
  if (!currentDetailDeviceId) return;
  const device = getDeviceById(currentDetailDeviceId);
  if (!device) {
    closeDeviceDetail();
    return;
  }
  setDeviceDetailTitle(device.name);
  setDeviceDetailControlStates(currentDetailDeviceId);
  setDeviceDetailShedBehavior(currentDetailDeviceId);
  renderSteppedLoadDraft(device);
  setDeviceDetailDeltaValues(currentDetailDeviceId);
  renderDeviceDetailModes(device);
  updateDeltaSectionVisibility();
  updateShedFieldVisibility();
};

const initDeviceDetailRefreshHandlers = () => {
  document.addEventListener('devices-updated', () => {
    if (pendingOpenDeviceId) {
      const idToOpen = pendingOpenDeviceId;
      pendingOpenDeviceId = null;
      openDeviceDetail(idToOpen);
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
    if (!currentDetailDeviceId) return;
    if (!isDeviceDetailDiagnosticsExpanded()) return;
    const deviceId = currentDetailDeviceId;
    void refreshDeviceDetailDiagnostics({
      deviceId,
      isCurrentDevice: () => currentDetailDeviceId === deviceId && isDeviceDetailDiagnosticsExpanded(),
    });
  });
};

export const initDeviceDetailHandlers = () => {
  initDeviceDetailCloseHandlers();
  initDeviceDetailManagedHandler();
  initDeviceDetailControllableHandler();
  initDeviceDetailControlModelHandler();
  initDeviceDetailPriceOptHandlers();
  initDeviceDetailShedHandlers();
  initDeviceDetailSteppedHandlers();
  initDeviceDetailDiagnosticsHandler();
  initDeviceDetailEscapeHandler();
  initDeviceDetailOpenHandler();
  initDeviceDetailRefreshHandlers();
};
