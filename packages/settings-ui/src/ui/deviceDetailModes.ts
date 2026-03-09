import type { TargetDeviceSnapshot } from '../../../contracts/src/types';
import { deviceDetailModes } from './dom';
import { setSetting } from './homey';
import { state } from './state';
import { renderPriorities } from './modes';
import { showToastError } from './toast';
import { logSettingsError } from './logging';
import { supportsTemperatureDevice } from './deviceUtils';

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

export const renderDeviceDetailModes = (device: TargetDeviceSnapshot) => {
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
