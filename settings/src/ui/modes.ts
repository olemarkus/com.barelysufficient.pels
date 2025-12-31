import Sortable from 'sortablejs';
import type { TargetDeviceSnapshot } from '../../../lib/utils/types';
import {
  modeSelect,
  activeModeSelect,
  priorityList,
  priorityEmpty,
  modeNewInput,
  addModeButton,
  deleteModeButton,
  renameModeButton,
} from './dom';
import { getSetting, setSetting } from './homey';
import { OPERATING_MODE_SETTING } from '../../../lib/utils/settingsKeys';
import { showToast, showToastError } from './toast';
import { resolveManagedState, state } from './state';
import { createDragHandle } from './components';
import { logSettingsError } from './logging';

export const loadModeAndPriorities = async () => {
  const mode = await getSetting(OPERATING_MODE_SETTING);
  const priorities = await getSetting('capacity_priorities');
  const targets = await getSetting('mode_device_targets');
  const controllables = await getSetting('controllable_devices');
  const managed = await getSetting('managed_devices');
  const aliases = await getSetting('mode_aliases');
  state.activeMode = typeof mode === 'string' && mode.trim() ? mode : 'Home';
  state.editingMode = state.activeMode; // Start editing the active mode
  state.capacityPriorities = priorities && typeof priorities === 'object'
    ? priorities as Record<string, Record<string, number>>
    : {};
  state.modeTargets = targets && typeof targets === 'object'
    ? targets as Record<string, Record<string, number>>
    : {};
  state.controllableMap = controllables && typeof controllables === 'object'
    ? controllables as Record<string, boolean>
    : {};
  state.managedMap = managed && typeof managed === 'object'
    ? managed as Record<string, boolean>
    : {};
  state.modeAliases = aliases && typeof aliases === 'object'
    ? Object.entries(aliases).reduce<Record<string, string>>((acc, [k, v]) => {
      if (typeof k === 'string' && typeof v === 'string') {
        return { ...acc, [k.toLowerCase()]: v };
      }
      return acc;
    }, {})
    : {};
  renderModeOptions();
};

export const refreshActiveMode = async () => {
  const mode = await getSetting(OPERATING_MODE_SETTING);
  state.activeMode = typeof mode === 'string' && mode.trim() ? mode : 'Home';
  if (activeModeSelect) {
    activeModeSelect.value = state.activeMode;
  }
};

export const renderModeOptions = () => {
  const modes = new Set([state.activeMode]);
  Object.keys(state.capacityPriorities || {}).forEach((m) => modes.add(m));
  Object.keys(state.modeTargets || {}).forEach((m) => modes.add(m));
  if (modes.size === 0) modes.add('Home');
  const sortedModes = Array.from(modes).sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));

  if (modeSelect) {
    modeSelect.innerHTML = '';
    sortedModes.forEach((m) => {
      const opt = document.createElement('option');
      opt.value = m;
      opt.textContent = m;
      if (m === state.editingMode) opt.selected = true;
      modeSelect.appendChild(opt);
    });
  }

  if (activeModeSelect) {
    activeModeSelect.innerHTML = '';
    sortedModes.forEach((m) => {
      const opt = document.createElement('option');
      opt.value = m;
      opt.textContent = m;
      if (m === state.activeMode) opt.selected = true;
      activeModeSelect.appendChild(opt);
    });
  }
};

const getPriorityRows = (): HTMLElement[] => (
  Array.from(priorityList?.querySelectorAll<HTMLElement>('.device-row') || [])
);

export const getPriority = (deviceId: string) => {
  const mode = state.editingMode || 'Home';
  return state.capacityPriorities[mode]?.[deviceId] ?? 100;
};

export const getDesiredTarget = (device: TargetDeviceSnapshot) => {
  const mode = state.editingMode || 'Home';
  const value = state.modeTargets[mode]?.[device.id];
  if (typeof value === 'number') return value;
  const firstTarget = device.targets?.find?.(() => true);
  if (firstTarget && typeof firstTarget.value === 'number') return firstTarget.value;
  return null;
};

const buildPriorityRow = (device: TargetDeviceSnapshot) => {
  const row = document.createElement('div');
  row.className = 'device-row draggable mode-row';
  row.setAttribute('role', 'listitem');
  row.dataset.deviceId = device.id;

  const name = document.createElement('div');
  name.className = 'device-row__name';
  name.textContent = device.name;

  const desired = getDesiredTarget(device);
  const input = document.createElement('input');
  input.type = 'number';
  input.step = '0.5';
  input.inputMode = 'decimal';
  input.placeholder = 'Desired °C';
  input.value = desired === null ? '' : desired.toString();
  input.dataset.deviceId = device.id;
  input.className = 'mode-target-input';
  input.addEventListener('change', () => {
    applyTargetChange(device.id, input.value);
  });

  const badge = document.createElement('span');
  badge.className = 'chip priority-badge';
  badge.textContent = '…';

  const badgeWrap = document.createElement('div');
  badgeWrap.className = 'mode-row__inputs';
  badgeWrap.appendChild(badge);

  row.append(createDragHandle(), name, input, badgeWrap);
  return row;
};

export const renderPriorities = (devices: TargetDeviceSnapshot[]) => {
  if (!priorityList) return;
  priorityList.innerHTML = '';
  const managedDevices = devices.filter((device) => resolveManagedState(device.id));
  if (!managedDevices.length) {
    priorityEmpty.hidden = false;
    return;
  }
  priorityEmpty.hidden = true;

  const sorted = [...managedDevices].sort((a, b) => getPriority(a.id) - getPriority(b.id));
  sorted.forEach((device) => {
    priorityList.appendChild(buildPriorityRow(device));
  });

  initSortable();
  refreshPriorityBadges();
};

export const setActiveMode = async (mode: string) => {
  const next = (mode || '').trim() || 'Home';
  state.activeMode = next;
  renderModeOptions();
  try {
    await setSetting(OPERATING_MODE_SETTING, state.activeMode);
  } catch (error) {
    await logSettingsError('Failed to set active mode', error, 'setActiveMode');
    await showToastError(error as Error, 'Failed to set active mode.');
    throw error;
  }
};

export const setEditingMode = (mode: string) => {
  const next = (mode || '').trim() || 'Home';
  state.editingMode = next;
  renderModeOptions();
  renderPriorities(state.latestDevices);
};

export const renameMode = async (oldName: string, newName: string) => {
  const oldKey = (oldName || '').trim();
  const newKey = (newName || '').trim();
  if (!oldKey || !newKey || oldKey === newKey) return;
  if (state.capacityPriorities[newKey] || state.modeTargets[newKey]) {
    await showToast('Mode name already exists.', 'warn');
    return;
  }
  if (state.capacityPriorities[oldKey]) {
    state.capacityPriorities[newKey] = state.capacityPriorities[oldKey];
    delete state.capacityPriorities[oldKey];
  }
  if (state.modeTargets[oldKey]) {
    state.modeTargets[newKey] = state.modeTargets[oldKey];
    delete state.modeTargets[oldKey];
  }
  state.modeAliases[oldKey.toLowerCase()] = newKey;
  if (state.activeMode === oldKey) {
    state.activeMode = newKey;
    await setSetting(OPERATING_MODE_SETTING, state.activeMode);
  }
  if (state.editingMode === oldKey) state.editingMode = newKey;
  await setSetting('capacity_priorities', state.capacityPriorities);
  await setSetting('mode_device_targets', state.modeTargets);
  await setSetting('mode_aliases', state.modeAliases);
  renderModeOptions();
  renderPriorities(state.latestDevices);
  await showToast(`Renamed mode to ${newKey}`, 'ok');
};

const refreshPriorityBadges = () => {
  const rows = getPriorityRows();
  rows.forEach((row, index) => {
    const badge = row.querySelector<HTMLElement>('.priority-badge');
    if (badge) badge.textContent = `#${index + 1}`;
  });
};

let sortableInstance: Sortable | null = null;

const initSortable = () => {
  if (sortableInstance) {
    sortableInstance.destroy();
  }
  if (!priorityList) return;

  sortableInstance = new Sortable(priorityList, {
    animation: 150,
    handle: '.drag-handle',
    ghostClass: 'sortable-ghost',
    chosenClass: 'sortable-chosen',
    dragClass: 'sortable-drag',
    forceFallback: true,
    fallbackClass: 'sortable-fallback',
    fallbackOnBody: true,
    delay: 150,
    delayOnTouchOnly: true,
    touchStartThreshold: 5,
    onEnd: async () => {
      refreshPriorityBadges();
      await savePriorities();
    },
  });
};

export const savePriorities = async () => {
  try {
    const mode = (modeSelect?.value || '').trim() || 'Home';
    state.editingMode = mode;
    const rows = getPriorityRows();
    const modeMap = state.capacityPriorities[mode] || {};
    rows.forEach((row, index) => {
      const id = row.dataset.deviceId;
      if (id) {
        modeMap[id] = index + 1;
      }
    });
    state.capacityPriorities[mode] = modeMap;
    await setSetting('capacity_priorities', state.capacityPriorities);
    await showToast(`Priorities saved for ${mode}.`, 'ok');
  } catch (error) {
    await logSettingsError('Failed to save priorities', error, 'savePriorities');
    await showToastError(error as Error, 'Failed to save priorities.');
  }
};

export const applyTargetChange = async (deviceId: string, rawValue: string) => {
  try {
    const mode = (modeSelect?.value || state.editingMode || 'Home').trim() || 'Home';
    state.editingMode = mode;
    const val = parseFloat(rawValue);
    if (!Number.isFinite(val)) return;
    if (!state.modeTargets[mode]) state.modeTargets[mode] = {};
    state.modeTargets[mode][deviceId] = val;
    await setSetting('mode_device_targets', state.modeTargets);
  } catch (error) {
    await logSettingsError('Failed to update mode target', error, 'applyTargetChange');
    await showToastError(error as Error, 'Failed to update mode target.');
  }
};

const buildPrioritiesFromDevices = (devices: TargetDeviceSnapshot[]) => (
  Object.fromEntries(devices.map((device, index) => [device.id, index + 1]))
);

const getPriorityTemplate = (
  storedPriorities: Record<string, Record<string, number>> | null,
  templateMode: string,
) => {
  let template = (storedPriorities && storedPriorities[templateMode])
    || (storedPriorities && storedPriorities.Home)
    || state.capacityPriorities[templateMode]
    || state.capacityPriorities.Home
    || {};
  if (Object.keys(template).length === 0 && storedPriorities) {
    const source = storedPriorities[templateMode] || storedPriorities.Home || {};
    template = Object.fromEntries(Object.keys(source).map((deviceId, index) => [deviceId, index + 1]));
  }
  if (Object.keys(template).length === 0 && Array.isArray(state.latestDevices)) {
    template = buildPrioritiesFromDevices(state.latestDevices);
  }
  return template;
};

const getTargetTemplate = (
  storedTargets: Record<string, Record<string, number>> | null,
  templateMode: string,
) => (
  (storedTargets && storedTargets[templateMode])
  || (storedTargets && storedTargets.Home)
  || state.modeTargets[templateMode]
  || state.modeTargets.Home
  || {}
);

const ensureModeTemplates = async (mode: string) => {
  if (Object.keys(state.capacityPriorities || {}).length === 0 || Object.keys(state.modeTargets || {}).length === 0) {
    await loadModeAndPriorities();
  }
  const templateMode = state.activeMode || 'Home';
  const storedPriorities = await getSetting('capacity_priorities') as Record<string, Record<string, number>> | null;
  const storedTargets = await getSetting('mode_device_targets') as Record<string, Record<string, number>> | null;

  if (!state.capacityPriorities[mode]) {
    const template = getPriorityTemplate(storedPriorities, templateMode);
    state.capacityPriorities = {
      ...(storedPriorities || {}),
      ...(state.capacityPriorities || {}),
      [mode]: { ...template },
    };
  }
  if (!state.modeTargets[mode]) {
    const templateTargets = getTargetTemplate(storedTargets, templateMode);
    state.modeTargets = {
      ...(storedTargets || {}),
      ...(state.modeTargets || {}),
      [mode]: { ...templateTargets },
    };
  }
};

const handleAddMode = async () => {
  try {
    const mode = (modeNewInput?.value || '').trim();
    if (!mode) return;
    await ensureModeTemplates(mode);
    state.editingMode = mode;
    renderModeOptions();
    renderPriorities(state.latestDevices);
    await setSetting('capacity_priorities', state.capacityPriorities);
    await setSetting('mode_device_targets', state.modeTargets);
    modeNewInput.value = '';
    await showToast(`Added mode ${mode}`, 'ok');
  } catch (error) {
    await logSettingsError('Failed to add mode', error, 'handleAddMode');
    await showToastError(error as Error, 'Failed to add mode.');
  }
};

const handleDeleteMode = async () => {
  try {
    const mode = modeSelect?.value || state.editingMode;
    if (!mode || !state.capacityPriorities[mode]) return;
    delete state.capacityPriorities[mode];
    if (state.modeTargets[mode]) delete state.modeTargets[mode];
    if (state.activeMode === mode) {
      state.activeMode = 'Home';
      await setSetting(OPERATING_MODE_SETTING, state.activeMode);
    }
    state.editingMode = 'Home';
    renderModeOptions();
    renderPriorities(state.latestDevices);
    await setSetting('capacity_priorities', state.capacityPriorities);
    await setSetting('mode_device_targets', state.modeTargets);
    await showToast(`Deleted mode ${mode}`, 'warn');
  } catch (error) {
    await logSettingsError('Failed to delete mode', error, 'handleDeleteMode');
    await showToastError(error as Error, 'Failed to delete mode.');
  }
};

const handleRenameMode = async () => {
  try {
    const oldMode = modeSelect?.value || state.editingMode;
    const newMode = (modeNewInput?.value || '').trim();
    if (!newMode) return;
    await renameMode(oldMode, newMode);
    modeNewInput.value = '';
  } catch (error) {
    await logSettingsError('Failed to rename mode', error, 'handleRenameMode');
    await showToastError(error as Error, 'Failed to rename mode.');
  }
};

export const initModeHandlers = () => {
  modeSelect?.addEventListener('change', () => {
    setEditingMode(modeSelect.value || 'Home');
  });
  activeModeSelect?.addEventListener('change', async () => {
    const mode = (activeModeSelect?.value || '').trim();
    if (!mode) return;
    try {
      await setActiveMode(mode);
      await showToast(`Active mode set to ${mode}`, 'ok');
    } catch {
      // setActiveMode already logged and toasted
    }
  });
  addModeButton?.addEventListener('click', handleAddMode);
  deleteModeButton?.addEventListener('click', handleDeleteMode);
  renameModeButton?.addEventListener('click', handleRenameMode);
};
