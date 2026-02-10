import type { TargetDeviceSnapshot } from '../../../lib/utils/types';
import {
  deviceDetailOverlay,
  deviceDetailTitle,
  deviceDetailClose,
  deviceDetailManaged,
  deviceDetailControllable,
  deviceDetailPriceOpt,
  deviceDetailModes,
  deviceDetailDeltaSection,
  deviceDetailCheapDelta,
  deviceDetailExpensiveDelta,
  deviceDetailShedAction,
  deviceDetailShedTempRow,
  deviceDetailShedTemp,
} from './dom';
import { getSetting, setSetting } from './homey';
import { resolveManagedState, state, defaultPriceOptimizationConfig } from './state';
import { renderDevices } from './devices';
import { renderPriorities } from './modes';
import { renderPriceOptimization, savePriceOptimizationSettings } from './priceOptimization';
import { showToastError } from './toast';
import { logSettingsError } from './logging';
import {
  supportsManagedDevice,
  supportsPowerDevice,
  supportsTemperatureDevice,
} from './deviceUtils';
import { AIRTREATMENT_SHED_FLOOR_C, NON_ONOFF_TEMPERATURE_SHED_FLOOR_C } from '../../../lib/utils/airtreatmentConstants';
import {
  OVERSHOOT_BEHAVIORS,
} from '../../../lib/utils/settingsKeys';
import {
  computeDefaultAirtreatmentShedTemperature,
  normalizeShedTemperature,
} from '../../../lib/utils/airtreatmentShedTemperature';

let currentDetailDeviceId: string | null = null;

type ShedAction = 'turn_off' | 'set_temperature';

const getDeviceById = (deviceId: string) => state.latestDevices.find((device) => device.id === deviceId) || null;

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
}): void => {
  if (!deviceDetailShedAction) return;
  const { canConfigure, forceTemperatureOnly, supportsTemperature } = params;
  const turnOffOption = deviceDetailShedAction.querySelector('option[value="turn_off"]');
  const setTempOption = deviceDetailShedAction.querySelector('option[value="set_temperature"]');
  if (turnOffOption) {
    turnOffOption.disabled = !canConfigure || forceTemperatureOnly;
    turnOffOption.hidden = forceTemperatureOnly;
  }
  if (setTempOption) {
    setTempOption.disabled = !canConfigure;
    setTempOption.hidden = !supportsTemperature;
  }
  deviceDetailShedAction.disabled = !canConfigure || forceTemperatureOnly;
};

const resolveShedActionValue = (params: {
  canConfigure: boolean;
  forceTemperatureOnly: boolean;
  configuredAction: ShedAction | undefined;
}): ShedAction => {
  const { canConfigure, forceTemperatureOnly, configuredAction } = params;
  if (!canConfigure) return 'turn_off';
  if (forceTemperatureOnly) return 'set_temperature';
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
};

const setDeviceDetailShedBehavior = (deviceId: string) => {
  const device = getDeviceById(deviceId);
  const supportsTemperature = supportsTemperatureDevice(device);
  const supportsPower = supportsPowerDevice(device);
  const canConfigure = supportsTemperature && supportsPower;
  const forceTemperatureOnly = canConfigure && isTemperatureDeviceWithoutOnOff(device);
  const shedConfig = state.shedBehaviors[deviceId];
  updateShedActionOptions({ canConfigure, forceTemperatureOnly, supportsTemperature });
  if (deviceDetailShedAction) {
    const nextAction = resolveShedActionValue({
      canConfigure,
      forceTemperatureOnly,
      configuredAction: shedConfig?.action,
    });
    deviceDetailShedAction.value = nextAction;
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
  const modeTarget = state.modeTargets[state.activeMode]?.[deviceId] ?? state.modeTargets[state.editingMode]?.[deviceId];
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

const updateShedTempVisibility = () => {
  if (!deviceDetailShedAction || !deviceDetailShedTempRow) return;
  const device = currentDetailDeviceId ? getDeviceById(currentDetailDeviceId) : null;
  if (!supportsTemperatureDevice(device) || !supportsPowerDevice(device)) {
    deviceDetailShedTempRow.hidden = true;
    if (deviceDetailShedTemp) {
      deviceDetailShedTemp.disabled = true;
    }
    return;
  }
  const isTemp = isTemperatureDeviceWithoutOnOff(device) || deviceDetailShedAction.value === 'set_temperature';
  deviceDetailShedTempRow.hidden = !isTemp;
  if (deviceDetailShedTemp) {
    deviceDetailShedTemp.disabled = !isTemp;
    if (isTemp && !deviceDetailShedTemp.value) {
      const fallback = getShedDefaultTemp(currentDetailDeviceId);
      deviceDetailShedTemp.value = fallback.toString();
    }
  }
};

const getAllModes = () => {
  const modes = new Set([state.activeMode]);
  Object.keys(state.capacityPriorities || {}).forEach((mode) => modes.add(mode));
  Object.keys(state.modeTargets || {}).forEach((mode) => modes.add(mode));
  if (modes.size === 0) modes.add('Home');
  return Array.from(modes).sort();
};

const getPriorityLabel = (mode: string, deviceId: string) => {
  const priority = state.capacityPriorities[mode]?.[deviceId] ?? 100;
  return `Priority: #${priority <= 100 ? priority : '—'}`;
};

const getTargetInputValue = (mode: string, device: TargetDeviceSnapshot) => {
  const currentTarget = state.modeTargets[mode]?.[device.id];
  const defaultTarget = device.targets?.[0]?.value;
  if (typeof currentTarget === 'number') return currentTarget.toString();
  if (typeof defaultTarget === 'number') return defaultTarget.toString();
  return '';
};

const buildDeviceDetailModeRow = (mode: string, device: TargetDeviceSnapshot) => {
  const row = document.createElement('div');
  row.className = 'detail-mode-row';
  row.dataset.mode = mode;

  const nameWrap = document.createElement('div');
  nameWrap.className = 'detail-mode-row__name';

  const nameSpan = document.createElement('span');
  nameSpan.textContent = mode;
  nameWrap.appendChild(nameSpan);

  if (mode === state.activeMode) {
    const badge = document.createElement('span');
    badge.className = 'active-badge';
    badge.textContent = 'Active';
    nameWrap.appendChild(badge);
  }

  const prioritySpan = document.createElement('div');
  prioritySpan.className = 'detail-mode-row__priority';
  prioritySpan.textContent = getPriorityLabel(mode, device.id);
  nameWrap.appendChild(prioritySpan);

  const tempInput = document.createElement('input');
  tempInput.type = 'number';
  tempInput.step = '0.5';
  tempInput.inputMode = 'decimal';
  tempInput.placeholder = '°C';
  tempInput.className = 'detail-mode-temp';
  tempInput.dataset.mode = mode;
  tempInput.value = getTargetInputValue(mode, device);

  tempInput.addEventListener('change', async () => {
    const value = parseFloat(tempInput.value);
    if (!isNaN(value)) {
      if (!state.modeTargets[mode]) state.modeTargets[mode] = {};
      state.modeTargets[mode][device.id] = value;
      try {
        await setSetting('mode_device_targets', state.modeTargets);
        renderPriorities(state.latestDevices);
      } catch (error) {
        await logSettingsError('Failed to update device target', error, 'device detail');
        await showToastError(error, 'Failed to update device target.');
      }
    }
  });

  row.append(nameWrap, tempInput);
  return row;
};

const renderDeviceDetailModes = (device: TargetDeviceSnapshot) => {
  if (!deviceDetailModes) return;
  deviceDetailModes.innerHTML = '';

  if (!supportsTemperatureDevice(device)) {
    const note = document.createElement('p');
    note.className = 'muted';
    note.textContent = 'Temperature targets are not available for on/off devices.';
    deviceDetailModes.appendChild(note);
    return;
  }
  getAllModes().forEach((mode) => {
    deviceDetailModes.appendChild(buildDeviceDetailModeRow(mode, device));
  });
};

const saveShedBehavior = async () => {
  const deviceId = currentDetailDeviceId;
  if (!deviceId) return;
  const device = getDeviceById(deviceId);
  if (!supportsTemperatureDevice(device) || !supportsPowerDevice(device)) {
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

export const loadShedBehaviors = async () => {
  try {
    const behaviors = await getSetting(OVERSHOOT_BEHAVIORS);
    state.shedBehaviors = behaviors && typeof behaviors === 'object'
      ? behaviors as Record<string, { action: ShedAction; temperature?: number }>
      : {};
  } catch (error) {
    await logSettingsError('Failed to load shed behaviors', error, 'loadShedBehaviors');
  }
};

export const openDeviceDetail = (deviceId: string) => {
  const device = getDeviceById(deviceId);
  if (!device) return;

  currentDetailDeviceId = deviceId;

  setDeviceDetailTitle(device.name);
  setDeviceDetailControlStates(deviceId);
  setDeviceDetailShedBehavior(deviceId);

  renderDeviceDetailModes(device);

  setDeviceDetailDeltaValues(deviceId);

  updateDeltaSectionVisibility();
  updateShedTempVisibility();

  showDeviceDetailOverlay();
};

const closeDeviceDetail = () => {
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
    updateShedTempVisibility();
    try {
      await saveShedBehavior();
    } catch (error) {
      await logSettingsError('Failed to save shed behavior', error, 'device detail');
      await showToastError(error, 'Failed to save shed behavior.');
    }
  };
  deviceDetailShedAction?.addEventListener('change', autoSaveShedBehavior);
  deviceDetailShedTemp?.addEventListener('change', autoSaveShedBehavior);
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
    if (custom.detail?.deviceId) {
      openDeviceDetail(custom.detail.deviceId);
    }
  });
};

export const initDeviceDetailHandlers = () => {
  initDeviceDetailCloseHandlers();
  initDeviceDetailManagedHandler();
  initDeviceDetailControllableHandler();
  initDeviceDetailPriceOptHandlers();
  initDeviceDetailShedHandlers();
  initDeviceDetailEscapeHandler();
  initDeviceDetailOpenHandler();
};
