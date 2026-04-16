import type { TargetDeviceSnapshot } from '../../../../contracts/src/types.ts';
import {
  getPrimaryTargetCapability,
  getTargetCapabilityStep,
  normalizeTargetCapabilityValue,
} from '../../../../contracts/src/targetCapabilities.ts';
import { deviceDetailModes } from '../dom.ts';
import { state } from '../state.ts';
import { showToastError } from '../toast.ts';
import { logSettingsError } from '../logging.ts';
import { supportsTemperatureDevice } from '../deviceUtils.ts';
import { debouncedSetSetting } from '../utils.ts';
import { renderPriorities } from '../modes.ts';

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
  const target = getPrimaryTargetCapability(device.targets);
  const currentTarget = state.modeTargets[mode]?.[device.id];
  const defaultTarget = device.targets?.[0]?.value;
  if (typeof currentTarget === 'number') {
    return normalizeTargetCapabilityValue({ target, value: currentTarget }).toString();
  }
  if (typeof defaultTarget === 'number') {
    return normalizeTargetCapabilityValue({ target, value: defaultTarget }).toString();
  }
  return '';
};

const getTargetBounds = (
  target: ReturnType<typeof getPrimaryTargetCapability>,
) => {
  const bounds: { max?: string; min?: string } = {};
  if (typeof target?.min === 'number' && Number.isFinite(target.min)) {
    bounds.min = target.min.toString();
  }
  if (typeof target?.max === 'number' && Number.isFinite(target.max)) {
    bounds.max = target.max.toString();
  }
  return bounds;
};

const buildDeviceDetailModeInput = (
  mode: string,
  device: TargetDeviceSnapshot,
  target: ReturnType<typeof getPrimaryTargetCapability>,
) => {
  const tempInput = document.createElement('input');
  tempInput.type = 'number';
  tempInput.step = getTargetCapabilityStep(target).toString();
  const bounds = getTargetBounds(target);
  if (bounds.min) tempInput.min = bounds.min;
  if (bounds.max) tempInput.max = bounds.max;
  tempInput.inputMode = 'decimal';
  tempInput.placeholder = '°C';
  tempInput.className = 'detail-mode-temp';
  tempInput.dataset.mode = mode;
  tempInput.value = getTargetInputValue(mode, device);
  return tempInput;
};

const bindDeviceDetailModeInput = (
  tempInput: HTMLInputElement,
  mode: string,
  device: TargetDeviceSnapshot,
  target: ReturnType<typeof getPrimaryTargetCapability>,
) => {
  const inputElement = tempInput;
  tempInput.addEventListener('change', async () => {
    const value = parseFloat(inputElement.value);
    if (isNaN(value)) return;

    const normalizedValue = normalizeTargetCapabilityValue({ target, value });
    inputElement.value = normalizedValue.toString();
    if (!state.modeTargets[mode]) state.modeTargets[mode] = {};
    state.modeTargets[mode][device.id] = normalizedValue;
    try {
      await debouncedSetSetting('mode_device_targets', () => state.modeTargets);
      renderPriorities(state.latestDevices);
    } catch (error) {
      await logSettingsError('Failed to update device target', error, 'device detail');
      await showToastError(error, 'Failed to update device target.');
    }
  });
};

const buildDeviceDetailModeRow = (mode: string, device: TargetDeviceSnapshot) => {
  const row = document.createElement('div');
  row.className = 'device-row detail-mode-row';
  row.dataset.mode = mode;

  const nameWrap = document.createElement('div');
  nameWrap.className = 'device-row__name detail-mode-row__name';

  const header = document.createElement('div');
  header.className = 'detail-mode-row__header';

  const nameSpan = document.createElement('span');
  nameSpan.className = 'device-row__title';
  nameSpan.textContent = mode;
  header.appendChild(nameSpan);

  if (mode === state.activeMode) {
    const badge = document.createElement('span');
    badge.className = 'active-badge';
    badge.textContent = 'Active';
    header.appendChild(badge);
  }
  nameWrap.appendChild(header);

  const prioritySpan = document.createElement('div');
  prioritySpan.className = 'detail-mode-row__priority';
  prioritySpan.textContent = getPriorityLabel(mode, device.id);
  nameWrap.appendChild(prioritySpan);

  const target = getPrimaryTargetCapability(device.targets);
  const tempInput = buildDeviceDetailModeInput(mode, device, target);
  bindDeviceDetailModeInput(tempInput, mode, device, target);

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
