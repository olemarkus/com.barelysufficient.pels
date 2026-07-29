import Sortable from 'sortablejs';
import type { SettingsUiDeviceListItem } from './deviceUtils.ts';
import {
  getPrimaryTargetCapability,
  getTargetCapabilityStep,
  normalizeTargetCapabilityValue,
} from '../../../contracts/src/targetCapabilities.ts';
import {
  modeSelect,
  priorityList,
  priorityEmpty,
  modeNewInput,
} from './dom.ts';
import {
  closeModeNameEditor,
  initModeEditor,
} from './modeEditor.ts';
import { getSetting, setSetting } from './homey.ts';
import {
  MAIN_HOME_ID,
  CAPACITY_PRIORITIES,
  MODE_DEVICE_TARGETS,
  OPERATING_MODE_SETTING,
  homeScopedSettingsKey,
} from '../../../contracts/src/settingsKeys.ts';
import { showToast, showToastError } from './toast.ts';
import { resolveManagedState, state } from './state.ts';
import { createDragHandle } from './components.ts';
import { logSettingsError } from './logging.ts';
import { DEFAULT_MODE_NAME, resolveModeName } from '../../../shared-domain/src/modeLabels.ts';
import { normalizeModePriorities } from '../../../shared-domain/src/modePriorities.ts';
import { formatDisplayDeviceName } from '../../../shared-domain/src/displayDeviceName.ts';
import { debouncedSetSetting } from './utils.ts';
import { getHomeIdForUiDevice, getHomeScope } from './homeScope.ts';
import {
  applyModeCatalog,
  captureModeCatalog,
  isModeMutationLocked,
  persistModeRename,
  serializeModeCatalogWrite,
  type ModeCatalogDraft,
  withModeMutationLock,
} from './modeRename.ts';
import { applyCurrentModeRename } from './currentModes.ts';
import { parseModeNumberMap, parseRequiredModeMaps } from './modeCatalogMaps.ts';
import {
  readBooleanSettingMap,
  readModeAliases,
  readModeSettings,
  readStrictBooleanSettingMap,
  type ModeSettingsRead,
} from './modeSettingsRead.ts';

type MaterialTextFieldElement = HTMLElement & {
  value: string;
  step: string;
  min: string;
  max: string;
  inputMode: string;
  placeholder: string;
};
type MaterialSelectOptionElement = HTMLElement & {
  value: string;
  selected: boolean;
  displayText: string;
  typeaheadText: string;
};

const createModeOption = (value: string, selected: boolean): MaterialSelectOptionElement => {
  const option = document.createElement('md-select-option') as MaterialSelectOptionElement;
  option.value = value;
  option.setAttribute('value', value);
  // Bypass md-select's deferred headline-slot lookup so its closed label is
  // available synchronously on first paint.
  option.displayText = value;
  option.typeaheadText = value;
  const headline = document.createElement('div');
  headline.slot = 'headline';
  headline.textContent = value;
  option.appendChild(headline);
  if (selected) option.setAttribute('selected', '');
  option.selected = selected;
  return option;
};

const supportsTemperatureDevice = (device: SettingsUiDeviceListItem): boolean => (
  device.deviceType === 'temperature' || Boolean(device.targets?.length));

const getPrimaryTemperatureTarget = (device: SettingsUiDeviceListItem) => getPrimaryTargetCapability(device.targets);

const normalizeDeviceTargetValue = (
  device: SettingsUiDeviceListItem,
  value: number,
): number => normalizeTargetCapabilityValue({ target: getPrimaryTemperatureTarget(device), value });

let modeLoadGeneration = 0;

const selectedModeSettingKey = (baseKey: string, homeId = getHomeScope().selectedHomeId): string => (
  homeScopedSettingsKey(baseKey, homeId)
);

const prepareModeHomeLoad = (homeId: string): void => {
  if (state.loadedModeHomeId === homeId) return;
  state.loadedModeHomeId = null;
  modeSelect?.replaceChildren();
  if (modeSelect) modeSelect.disabled = true;
  priorityList?.replaceChildren();
  if (priorityEmpty) priorityEmpty.hidden = true;
};

const applyModeSettings = (homeId: string, read: ModeSettingsRead): void => {
  const allowAbsent = homeId === MAIN_HOME_ID;
  const priorities = parseModeNumberMap(read.priorities, allowAbsent);
  const targets = parseModeNumberMap(read.targets, allowAbsent);
  if (priorities === null || targets === null) throw new Error('Mode catalog unavailable');
  state.loadedModeHomeId = homeId;
  if (modeSelect) modeSelect.disabled = false;
  state.activeMode = typeof read.mode === 'string' && read.mode.trim()
    ? read.mode
    : DEFAULT_MODE_NAME;
  state.editingMode = state.activeMode;
  state.capacityPriorities = normalizeModePriorities(priorities);
  state.modeTargets = targets;
  state.controllableMap = readBooleanSettingMap(read.controllables);
  state.managedMap = readBooleanSettingMap(read.managed);
  state.budgetExemptMap = readBooleanSettingMap(read.budgetExempt);
  state.respectExternalOffMap = readStrictBooleanSettingMap(read.respectExternalOff)
    ?? state.respectExternalOffMap;
  state.nativeWiringMap = readBooleanSettingMap(read.nativeWiring);
  state.modeAliases = readModeAliases(read.aliases);
  renderModeOptions();
};

export const loadModeAndPriorities = async () => {
  modeLoadGeneration += 1;
  const generation = modeLoadGeneration;
  const homeId = getHomeScope().selectedHomeId;
  prepareModeHomeLoad(homeId);
  const read = await readModeSettings(homeId);
  if (generation !== modeLoadGeneration || homeId !== getHomeScope().selectedHomeId) return;
  applyModeSettings(homeId, read);
};

export const renderModeOptions = () => {
  const modes = new Set([state.activeMode]);
  Object.keys(state.capacityPriorities || {}).forEach((m) => modes.add(m));
  Object.keys(state.modeTargets || {}).forEach((m) => modes.add(m));
  if (modes.size === 0) modes.add(DEFAULT_MODE_NAME);
  const sortedModes = Array.from(modes).sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));

  if (modeSelect) {
    modeSelect.replaceChildren(
      ...sortedModes.map((mode) => createModeOption(mode, mode === state.editingMode)),
    );
    modeSelect.value = state.editingMode || sortedModes[0] || DEFAULT_MODE_NAME;
  }
};

const getPriorityRows = (): HTMLElement[] => (
  Array.from(priorityList?.querySelectorAll<HTMLElement>('.device-row') || [])
);

export const getPriority = (deviceId: string) => {
  const mode = state.editingMode || DEFAULT_MODE_NAME;
  return state.capacityPriorities[mode]?.[deviceId] ?? 100;
};

export const getDesiredTarget = (device: SettingsUiDeviceListItem) => {
  if (!supportsTemperatureDevice(device)) return null;
  const mode = state.editingMode || DEFAULT_MODE_NAME;
  const value = state.modeTargets[mode]?.[device.id];
  if (typeof value === 'number') return normalizeDeviceTargetValue(device, value);
  const firstTarget = device.targets?.find?.(() => true);
  if (firstTarget && typeof firstTarget.value === 'number') {
    return normalizeDeviceTargetValue(device, firstTarget.value);
  }
  return null;
};

const buildOnOffPlaceholder = (): HTMLElement => {
  const placeholder = document.createElement('span');
  placeholder.className = 'mode-target-placeholder';
  placeholder.textContent = 'On/off only';
  return placeholder;
};

const buildModeTargetInput = (device: SettingsUiDeviceListItem, desired: number | null): HTMLElement => {
  if (!supportsTemperatureDevice(device)) return buildOnOffPlaceholder();
  const target = getPrimaryTemperatureTarget(device);
  const tempInput = document.createElement('md-filled-text-field') as MaterialTextFieldElement;
  tempInput.setAttribute('type', 'number');
  tempInput.step = getTargetCapabilityStep(target).toString();
  tempInput.setAttribute('step', tempInput.step);
  if (typeof target?.min === 'number' && Number.isFinite(target.min)) {
    tempInput.min = target.min.toString();
    tempInput.setAttribute('min', tempInput.min);
  }
  if (typeof target?.max === 'number' && Number.isFinite(target.max)) {
    tempInput.max = target.max.toString();
    tempInput.setAttribute('max', tempInput.max);
  }
  tempInput.inputMode = 'decimal';
  tempInput.placeholder = 'Desired';
  tempInput.setAttribute('inputmode', tempInput.inputMode);
  tempInput.setAttribute('placeholder', tempInput.placeholder);
  tempInput.setAttribute('suffix-text', '°C');
  tempInput.value = desired === null ? '' : desired.toString();
  tempInput.dataset.deviceId = device.id;
  tempInput.className = 'mode-target-input';
  tempInput.addEventListener('change', () => {
    const value = parseFloat(tempInput.value);
    if (Number.isFinite(value)) {
      tempInput.value = normalizeDeviceTargetValue(device, value).toString();
    }
    void applyTargetChange(device.id, tempInput.value);
  });
  return tempInput;
};

const buildPriorityRow = (device: SettingsUiDeviceListItem) => {
  const row = document.createElement('li');
  row.className = 'device-row draggable mode-row';
  row.dataset.deviceId = device.id;

  const name = document.createElement('div');
  name.className = 'device-row__name entity-name';
  const nameText = document.createElement('span');
  nameText.className = 'mode-row__name-text';
  nameText.textContent = formatDisplayDeviceName(device.name);
  name.appendChild(nameText);

  const desired = getDesiredTarget(device);
  const input = buildModeTargetInput(device, desired);

  const badge = document.createElement('span');
  // `.priority-badge` is a fully-styled pill (radius-full + positive bg) and
  // overrides every chip property; the legacy `chip` companion class added
  // no styles. Dropped 2026-05-24 chip primitive consolidation so the
  // priority pill stops aliasing as a chip in inspector / regression scans.
  badge.className = 'priority-badge';
  badge.textContent = '…';

  const badgeWrap = document.createElement('div');
  badgeWrap.className = 'mode-row__inputs';
  badgeWrap.appendChild(badge);

  row.append(createDragHandle(), name, input, badgeWrap);
  return row;
};

export const renderPriorities = (devices: SettingsUiDeviceListItem[]) => {
  if (!priorityList) return;
  priorityList.innerHTML = '';
  const selectedHomeId = getHomeScope().selectedHomeId;
  const managedDevices = devices.filter((device) => (
    resolveManagedState(device.id) && getHomeIdForUiDevice(device.id) === selectedHomeId
  ));
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

export const setEditingMode = (mode: string) => {
  const next = resolveModeName(mode);
  state.editingMode = next;
  renderModeOptions();
  renderPriorities(state.latestDevices);
};

export const renameMode = async (oldName: string, newName: string) => {
  const homeId = getHomeScope().selectedHomeId;
  if (state.loadedModeHomeId !== homeId) return;
  await withModeMutationLock(homeId, async () => {
    const { result, catalog } = await persistModeRename({
      oldName,
      newName,
      homeId,
      catalog: captureModeCatalog(),
    });
    if (result === 'duplicate') {
      await showToast('Mode name already exists.', 'warn');
      return;
    }
    if (result === 'noop') return;
    applyCurrentModeRename(homeId, oldName.trim(), newName.trim());
    if (state.loadedModeHomeId !== homeId) return;
    applyModeCatalog(catalog);
    renderModeOptions();
    renderPriorities(state.latestDevices);
    void showToast(`Renamed mode to ${newName.trim()}`, 'ok');
  });
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
    const homeId = getHomeScope().selectedHomeId;
    if (state.loadedModeHomeId !== homeId || isModeMutationLocked(homeId)) return;
    const mode = resolveModeName(modeSelect?.value || '');
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
    const prioritiesForSave = Object.fromEntries(
      Object.entries(state.capacityPriorities).map(([name, entries]) => [name, { ...entries }]),
    );
    await serializeModeCatalogWrite(homeId, () => (
      setSetting(selectedModeSettingKey(CAPACITY_PRIORITIES, homeId), prioritiesForSave)
    ));
    await showToast(`Priorities saved for ${mode}.`, 'ok');
  } catch (error) {
    await logSettingsError('Failed to save priorities', error, 'savePriorities');
    await showToastError(error as Error, 'Failed to save priorities.');
  }
};

export const applyTargetChange = async (deviceId: string, rawValue: string) => {
  try {
    const homeId = getHomeScope().selectedHomeId;
    if (state.loadedModeHomeId !== homeId || isModeMutationLocked(homeId)) return;
    const mode = resolveModeName(modeSelect?.value || state.editingMode || DEFAULT_MODE_NAME);
    state.editingMode = mode;
    const val = parseFloat(rawValue);
    if (!Number.isFinite(val)) return;
    const device = state.latestDevices.find((entry) => entry.id === deviceId);
    const normalizedValue = device ? normalizeDeviceTargetValue(device, val) : val;
    if (!state.modeTargets[mode]) state.modeTargets[mode] = {};
    state.modeTargets[mode][deviceId] = normalizedValue;
    const targetsForSave = Object.fromEntries(
      Object.entries(state.modeTargets).map(([name, entries]) => [name, { ...entries }]),
    );
    await serializeModeCatalogWrite(homeId, () => (
      debouncedSetSetting(
        selectedModeSettingKey(MODE_DEVICE_TARGETS, homeId),
        () => targetsForSave,
      )
    ));
  } catch (error) {
    await logSettingsError('Failed to update mode target', error, 'applyTargetChange');
    await showToastError(error as Error, 'Failed to update mode target.');
  }
};

const buildPrioritiesFromDeviceIds = (deviceIds: readonly string[]) => (
  Object.fromEntries(deviceIds.map((deviceId, index) => [deviceId, index + 1]))
);

const getPriorityTemplate = (
  priorities: Record<string, Record<string, number>>,
  templateMode: string,
  deviceIds: readonly string[],
) => {
  const template = priorities[templateMode] || priorities.Home || {};
  return Object.keys(template).length > 0
    ? template
    : buildPrioritiesFromDeviceIds(deviceIds);
};

const getTargetTemplate = (
  targets: Record<string, Record<string, number>>,
  templateMode: string,
) => (
  targets[templateMode]
  || targets.Home
  || {}
);

const ensureModeTemplates = async (
  mode: string,
  homeId: string,
  captured: ModeCatalogDraft,
): Promise<ModeCatalogDraft> => {
  const templateMode = captured.activeMode || DEFAULT_MODE_NAME;
  const deviceIds = state.latestDevices
    .filter((device) => getHomeIdForUiDevice(device.id) === homeId)
    .map((device) => device.id);
  const [prioritiesRaw, targetsRaw] = await Promise.all([
    getSetting(
    selectedModeSettingKey(CAPACITY_PRIORITIES, homeId),
    ),
    getSetting(
      selectedModeSettingKey(MODE_DEVICE_TARGETS, homeId),
    ),
  ]);
  const [storedPriorities, storedTargets] = parseRequiredModeMaps(prioritiesRaw, targetsRaw, homeId === MAIN_HOME_ID);
  const priorities = {
    ...storedPriorities,
    ...captured.priorities,
  };
  const targets = {
    ...storedTargets,
    ...captured.targets,
  };
  return {
    ...captured,
    editingMode: mode,
    priorities: priorities[mode]
      ? priorities
      : {
        ...priorities,
        [mode]: { ...getPriorityTemplate(priorities, templateMode, deviceIds) },
      },
    targets: targets[mode]
      ? targets
      : {
        ...targets,
        [mode]: { ...getTargetTemplate(targets, templateMode) },
      },
  };
};

const handleAddMode = async () => {
  const homeId = getHomeScope().selectedHomeId;
  if (state.loadedModeHomeId !== homeId) return;
  await withModeMutationLock(homeId, async () => {
    try {
      const mode = (modeNewInput?.value || '').trim();
      if (!mode) return;
      const catalog = await ensureModeTemplates(mode, homeId, captureModeCatalog());
      await setSetting(selectedModeSettingKey(CAPACITY_PRIORITIES, homeId), catalog.priorities);
      await setSetting(selectedModeSettingKey(MODE_DEVICE_TARGETS, homeId), catalog.targets);
      if (state.loadedModeHomeId !== homeId) return;
      applyModeCatalog(catalog);
      renderModeOptions();
      renderPriorities(state.latestDevices);
      modeNewInput.value = '';
      void showToast(`Added mode ${mode}`, 'ok');
    } catch (error) {
      await logSettingsError('Failed to add mode', error, 'handleAddMode');
      await showToastError(error as Error, 'Failed to add mode.');
    }
  });
};

const handleDeleteMode = async () => {
  const homeId = getHomeScope().selectedHomeId;
  if (state.loadedModeHomeId !== homeId) return;
  await withModeMutationLock(homeId, async () => {
    try {
      const mode = modeSelect?.value || state.editingMode;
      const catalog = captureModeCatalog();
      if (!mode || !catalog.priorities[mode]) return;
      const remainingModes = Object.keys(catalog.priorities).filter((entry) => entry !== mode);
      if (remainingModes.length === 0) {
        await showToast('Keep at least one mode.', 'warn');
        return;
      }
      delete catalog.priorities[mode];
      if (catalog.targets[mode]) delete catalog.targets[mode];
      if (catalog.activeMode === mode) {
        catalog.activeMode = remainingModes.includes(DEFAULT_MODE_NAME)
          ? DEFAULT_MODE_NAME
          : [...remainingModes].sort((left, right) => left.localeCompare(right))[0];
        await setSetting(
          selectedModeSettingKey(OPERATING_MODE_SETTING, homeId),
          catalog.activeMode,
        );
      }
      catalog.editingMode = catalog.activeMode;
      await setSetting(selectedModeSettingKey(CAPACITY_PRIORITIES, homeId), catalog.priorities);
      await setSetting(selectedModeSettingKey(MODE_DEVICE_TARGETS, homeId), catalog.targets);
      if (state.loadedModeHomeId !== homeId) return;
      applyModeCatalog(catalog);
      renderModeOptions();
      renderPriorities(state.latestDevices);
      void showToast(`Deleted mode ${mode}`, 'warn');
    } catch (error) {
      await logSettingsError('Failed to delete mode', error, 'handleDeleteMode');
      await showToastError(error as Error, 'Failed to delete mode.');
    }
  });
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
  initModeEditor({
    addMode: handleAddMode,
    renameMode: handleRenameMode,
    deleteMode: handleDeleteMode,
  });
  modeSelect?.addEventListener('change', () => {
    closeModeNameEditor();
    setEditingMode(modeSelect.value || DEFAULT_MODE_NAME);
  });
};
