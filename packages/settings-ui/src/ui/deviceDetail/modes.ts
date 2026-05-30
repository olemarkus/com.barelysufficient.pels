import type { TargetDeviceSnapshot } from '../../../../contracts/src/types.ts';
import {
  getPrimaryTargetCapability,
  getTargetCapabilityStep,
  normalizeTargetCapabilityValue,
} from '../../../../contracts/src/targetCapabilities.ts';
import { deviceDetailModes, deviceDetailModesSection, type MdFilledTextFieldElement } from '../dom.ts';
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
): MdFilledTextFieldElement => {
  const tempInput = document.createElement('md-filled-text-field') as MdFilledTextFieldElement;
  tempInput.setAttribute('type', 'number');
  tempInput.setAttribute('step', getTargetCapabilityStep(target).toString());
  const bounds = getTargetBounds(target);
  if (bounds.min) tempInput.setAttribute('min', bounds.min);
  if (bounds.max) tempInput.setAttribute('max', bounds.max);
  tempInput.setAttribute('inputmode', 'decimal');
  tempInput.setAttribute('suffix-text', '°C');
  tempInput.setAttribute('aria-label', `${mode} target temperature`);
  tempInput.classList.add('detail-mode-temp');
  tempInput.dataset.mode = mode;
  tempInput.value = getTargetInputValue(mode, device);
  return tempInput;
};

const bindDeviceDetailModeInput = (
  tempInput: MdFilledTextFieldElement,
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
  nameWrap.className = 'device-row__name entity-name detail-mode-row__name';

  const header = document.createElement('div');
  header.className = 'detail-mode-row__header';

  const nameSpan = document.createElement('span');
  nameSpan.className = 'device-row__title';
  nameSpan.textContent = mode;
  header.appendChild(nameSpan);

  if (mode === state.activeMode) {
    // Visual-only status pill. Hidden from assistive tech because the same
    // information is already conveyed by the row representing the user's
    // active mode; exposing this chip as a button would add a phantom
    // interactive element to keyboard and screen-reader navigation.
    const badge = document.createElement('md-assist-chip');
    badge.className = 'detail-mode-row__active-chip';
    badge.setAttribute('label', 'Active');
    badge.setAttribute('aria-hidden', 'true');
    badge.tabIndex = -1;
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
  while (deviceDetailModes.firstChild) deviceDetailModes.removeChild(deviceDetailModes.firstChild);

  // Per-mode temperature targets only apply to thermal devices. On/off and
  // stepped-load devices have no target temperature to set per mode, so hide
  // the whole section rather than render an empty-state placeholder.
  const supports = supportsTemperatureDevice(device);
  if (deviceDetailModesSection) deviceDetailModesSection.hidden = !supports;
  if (!supports) return;

  getAllModes().forEach((mode) => {
    deviceDetailModes.appendChild(buildDeviceDetailModeRow(mode, device));
  });
};
