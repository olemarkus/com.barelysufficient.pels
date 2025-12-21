import type { TargetDeviceSnapshot } from '../../../types';
import {
  deviceDetailOverlay,
  deviceDetailTitle,
  deviceDetailClose,
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
import { state, defaultPriceOptimizationConfig } from './state';
import { renderDevices } from './devices';
import { renderPriorities } from './modes';
import { renderPriceOptimization, savePriceOptimizationSettings } from './prices';

let currentDetailDeviceId: string | null = null;

type ShedAction = 'turn_off' | 'set_temperature';

const getDeviceById = (deviceId: string) => state.latestDevices.find((device) => device.id === deviceId) || null;

const setDeviceDetailTitle = (name: string) => {
  if (deviceDetailTitle) deviceDetailTitle.textContent = name;
};

const setDeviceDetailControlStates = (deviceId: string) => {
  if (deviceDetailControllable) {
    deviceDetailControllable.checked = state.controllableMap[deviceId] !== false;
  }

  const priceConfig = state.priceOptimizationSettings[deviceId];
  if (deviceDetailPriceOpt) {
    deviceDetailPriceOpt.checked = priceConfig?.enabled || false;
  }
};

const setDeviceDetailShedBehavior = (deviceId: string) => {
  const shedConfig = state.shedBehaviors[deviceId];
  if (deviceDetailShedAction) {
    deviceDetailShedAction.value = shedConfig?.action || 'turn_off';
  }
  if (deviceDetailShedTemp) {
    const temp = shedConfig?.temperature;
    deviceDetailShedTemp.value = typeof temp === 'number' ? temp.toString() : '';
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
  if (deviceDetailDeltaSection && deviceDetailPriceOpt) {
    deviceDetailDeltaSection.style.display = deviceDetailPriceOpt.checked ? 'block' : 'none';
  }
};

const getShedDefaultTemp = (deviceId: string | null): number => {
  if (!deviceId) return 10;
  const modeTarget = state.modeTargets[state.activeMode]?.[deviceId] ?? state.modeTargets[state.editingMode]?.[deviceId];
  if (typeof modeTarget === 'number') return modeTarget;
  const device = state.latestDevices.find((d) => d.id === deviceId);
  const currentTarget = device?.targets?.[0]?.value;
  if (typeof currentTarget === 'number') return currentTarget;
  return 10;
};

const updateShedTempVisibility = () => {
  if (!deviceDetailShedAction || !deviceDetailShedTempRow) return;
  const isTemp = deviceDetailShedAction.value === 'set_temperature';
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
      await setSetting('mode_device_targets', state.modeTargets);
      renderPriorities(state.latestDevices);
    }
  });

  row.append(nameWrap, tempInput);
  return row;
};

const renderDeviceDetailModes = (device: TargetDeviceSnapshot) => {
  if (!deviceDetailModes) return;
  deviceDetailModes.innerHTML = '';

  getAllModes().forEach((mode) => {
    deviceDetailModes.appendChild(buildDeviceDetailModeRow(mode, device));
  });
};

const saveShedBehavior = async () => {
  if (!currentDetailDeviceId) return;
  const deviceId = currentDetailDeviceId;
  const action: ShedAction = deviceDetailShedAction?.value === 'set_temperature' ? 'set_temperature' : 'turn_off';
  const parsedTemp = parseFloat(deviceDetailShedTemp?.value || '');
  const validTemp = Number.isFinite(parsedTemp) && parsedTemp >= -20 && parsedTemp <= 50 ? parsedTemp : null;

  if (action === 'set_temperature') {
    const temperature = validTemp ?? state.shedBehaviors[deviceId]?.temperature ?? getShedDefaultTemp(deviceId);
    state.shedBehaviors[deviceId] = { action, temperature };
    if (deviceDetailShedTemp && validTemp === null) {
      deviceDetailShedTemp.value = temperature.toString();
    }
  } else {
    state.shedBehaviors[deviceId] = { action: 'turn_off' };
  }

  await setSetting('overshoot_behaviors', state.shedBehaviors);
};

export const loadShedBehaviors = async () => {
  const behaviors = await getSetting('overshoot_behaviors');
  state.shedBehaviors = behaviors && typeof behaviors === 'object'
    ? behaviors as Record<string, { action: ShedAction; temperature?: number }>
    : {};
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
    await setSetting('controllable_devices', state.controllableMap);
    renderDevices(state.latestDevices);
  });
};

const ensurePriceOptimizationConfig = (deviceId: string) => {
  if (!state.priceOptimizationSettings[deviceId]) {
    state.priceOptimizationSettings[deviceId] = { ...defaultPriceOptimizationConfig };
  }
  return state.priceOptimizationSettings[deviceId];
};

const initDeviceDetailPriceOptHandlers = () => {
  const autoSavePriceOpt = async () => {
    if (!currentDetailDeviceId) return;
    const deviceId = currentDetailDeviceId;
    const priceOptEnabled = deviceDetailPriceOpt?.checked || false;
    const cheapDelta = parseFloat(deviceDetailCheapDelta?.value || '5');
    const expensiveDelta = parseFloat(deviceDetailExpensiveDelta?.value || '-5');

    const validCheapDelta = Number.isFinite(cheapDelta) && cheapDelta >= -20 && cheapDelta <= 20;
    const validExpensiveDelta = Number.isFinite(expensiveDelta) && expensiveDelta >= -20 && expensiveDelta <= 20;

    const config = ensurePriceOptimizationConfig(deviceId);
    config.enabled = priceOptEnabled;
    config.cheapDelta = validCheapDelta ? cheapDelta : 5;
    config.expensiveDelta = validExpensiveDelta ? expensiveDelta : -5;
    await savePriceOptimizationSettings();
    renderDevices(state.latestDevices);
    renderPriceOptimization(state.latestDevices);
    updateDeltaSectionVisibility();
  };

  deviceDetailPriceOpt?.addEventListener('change', autoSavePriceOpt);
  deviceDetailCheapDelta?.addEventListener('change', autoSavePriceOpt);
  deviceDetailExpensiveDelta?.addEventListener('change', autoSavePriceOpt);
};

const initDeviceDetailShedHandlers = () => {
  const autoSaveShedBehavior = async () => {
    updateShedTempVisibility();
    await saveShedBehavior();
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
  initDeviceDetailControllableHandler();
  initDeviceDetailPriceOptHandlers();
  initDeviceDetailShedHandlers();
  initDeviceDetailEscapeHandler();
  initDeviceDetailOpenHandler();
};
