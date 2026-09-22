import { ModePriorityCatalog, readModePriorityCatalog } from '../../../../shared-domain/src/settings/modePriorities.ts';
import {
  getPrimaryTargetCapability,
  getTargetCapabilityStep,
  normalizeTargetCapabilityValue,
} from '../../../../contracts/src/targetCapabilities.ts';
import { deviceDetailModes, deviceDetailModesSection, type MdFilledTextFieldElement } from '../dom.ts';
import { state } from '../state.ts';
import { showToastError } from '../toast.ts';
import { logSettingsError } from '../logging.ts';
import {
  supportsTemperatureControlDevice,
  supportsPowerDevice,
  supportsTemperatureDevice,
  type SettingsUiDeviceDetailItem,
} from '../deviceUtils.ts';
import { debouncedSetSetting } from '../utils.ts';
import { renderPriorities } from '../modes.ts';
import {
  CAPACITY_PRIORITIES,
  MAIN_HOME_ID,
  MODE_DEVICE_TARGETS,
  OPERATING_MODE_SETTING,
  homeScopedSettingsKey,
} from '../../../../contracts/src/settingsKeys.ts';
import { getSetting } from '../homey.ts';
import { getHomeIdForUiDevice } from '../homeScope.ts';
import {
  assertWritableModeDeviceTargets,
  readModeDeviceTargetsSetting,
} from '../modeCatalogMaps.ts';
import { serializeModeCatalogWrite } from '../modeRename.ts';
import { DEVICE_POWER_SUPPORT_REASON } from '../deviceControlAvailability.ts';

const modesHelpEl = document.querySelector<HTMLElement>('#device-detail-modes-help');
const MODES_HELP_ACTIVE = 'Set the target temperature for each mode. PELS will set this when the mode is active. '
  + 'Priority is this device’s place in that mode’s pecking order — higher-priority devices '
  + 'keep running longer and resume sooner; reorder it in Modes.';
const MODES_HELP_DISABLED = 'Saved target temperatures. '
  + 'PELS won’t apply them while Keep the new temperature is selected.';

type DetailModeCatalog = {
  activeMode: string;
  priorities: ModePriorityCatalog;
  targets: Record<string, Record<string, number>>;
};
type DetailModeDraft = { current: DetailModeCatalog };
type PendingTargetPatch = {
  mode: string;
  deviceId: string;
  value: number;
  revision: number;
};

const pendingTargetPatches = new Map<string, PendingTargetPatch[]>();
const pendingTargetSaves = new Map<string, Promise<void>>();
let targetPatchRevision = 0;

const mergeTargetPatches = (
  targets: Record<string, Record<string, number>>,
  patches: readonly PendingTargetPatch[],
): Record<string, Record<string, number>> => {
  const merged = Object.fromEntries(
    Object.entries(targets).map(([name, entries]) => [name, { ...entries }]),
  );
  for (const patch of patches) {
    merged[patch.mode] = {
      ...(merged[patch.mode] ?? {}),
      [patch.deviceId]: patch.value,
    };
  }
  return merged;
};

const persistTargetPatchBatch = async (homeId: string): Promise<void> => {
  await serializeModeCatalogWrite(homeId, async () => {
    if ((pendingTargetPatches.get(homeId)?.length ?? 0) === 0) return;
    const key = homeScopedSettingsKey(MODE_DEVICE_TARGETS, homeId);
    const stored = readModeDeviceTargetsSetting(
      await getSetting(key),
      homeId === MAIN_HOME_ID,
    );
    if (stored === null) throw new Error('Mode catalog unavailable');
    let flushedThroughRevision = 0;
    let flushedPatches: readonly PendingTargetPatch[] = [];
    try {
      await debouncedSetSetting(key, () => {
        const patches = pendingTargetPatches.get(homeId) ?? [];
        // ES2020-safe last-element access (no Array#at); bundle targets es2020.
        flushedThroughRevision = patches[patches.length - 1]?.revision ?? 0;
        flushedPatches = [...patches];
        return assertWritableModeDeviceTargets(mergeTargetPatches(stored, patches));
      });
      if (state.loadedModeHomeId === homeId) {
        state.modeTargets = mergeTargetPatches(state.modeTargets, flushedPatches);
      }
    } finally {
      const remaining = (pendingTargetPatches.get(homeId) ?? [])
        .filter((patch) => patch.revision > flushedThroughRevision);
      if (remaining.length === 0) pendingTargetPatches.delete(homeId);
      else pendingTargetPatches.set(homeId, remaining);
    }
  });
};

const persistPendingTargetPatches = (homeId: string): Promise<void> => {
  const pending = pendingTargetSaves.get(homeId);
  if (pending) return pending;
  const save = (async () => {
    while ((pendingTargetPatches.get(homeId)?.length ?? 0) > 0) {
      await persistTargetPatchBatch(homeId);
    }
  })().finally(() => {
    if (pendingTargetSaves.get(homeId) === save) pendingTargetSaves.delete(homeId);
  });
  pendingTargetSaves.set(homeId, save);
  return save;
};

const getAllModes = (catalog: DetailModeCatalog) => {
  const modes = new Set([catalog.activeMode]);
  catalog.priorities.modes().forEach((mode) => modes.add(mode));
  Object.keys(catalog.targets).forEach((mode) => modes.add(mode));
  if (modes.size === 0) modes.add('Home');
  return Array.from(modes).sort();
};

const getPriorityLabel = (catalog: DetailModeCatalog, mode: string, deviceId: string) => {
  const homeId = getHomeIdForUiDevice(deviceId);
  const deviceIds = state.latestDevices
    .filter((entry) => state.managedMap[entry.id] === true && getHomeIdForUiDevice(entry.id) === homeId)
    .map((entry) => entry.id);
  const order = catalog.priorities.getOrder(mode, [...deviceIds, deviceId]);
  return `Priority ${order.getPriority(deviceId)}`;
};

const getTargetInputValue = (
  catalog: DetailModeCatalog,
  mode: string,
  device: SettingsUiDeviceDetailItem,
) => {
  const target = getPrimaryTargetCapability(device.targets);
  const currentTarget = catalog.targets[mode]?.[device.id];
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
  device: SettingsUiDeviceDetailItem,
  target: ReturnType<typeof getPrimaryTargetCapability>,
  catalog: DetailModeCatalog,
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
  tempInput.value = getTargetInputValue(catalog, mode, device);
  tempInput.disabled = !supportsTemperatureControlDevice(device);
  return tempInput;
};

const bindDeviceDetailModeInput = (params: {
  tempInput: MdFilledTextFieldElement;
  mode: string;
  device: SettingsUiDeviceDetailItem;
  target: ReturnType<typeof getPrimaryTargetCapability>;
  draft: DetailModeDraft;
  homeId: string;
}) => {
  const {
    tempInput, mode, device, target, draft, homeId,
  } = params;
  const inputElement = tempInput;
  tempInput.addEventListener('change', async () => {
    if (!supportsTemperatureControlDevice(device)) return;
    const value = parseFloat(inputElement.value);
    if (isNaN(value)) return;

    const normalizedValue = normalizeTargetCapabilityValue({ target, value });
    inputElement.value = normalizedValue.toString();
    const nextModeTargets = {
      ...(draft.current.targets[mode] ?? {}),
      [device.id]: normalizedValue,
    };
    draft.current = {
      ...draft.current,
      targets: { ...draft.current.targets, [mode]: nextModeTargets },
    };
    targetPatchRevision += 1;
    const patches = pendingTargetPatches.get(homeId) ?? [];
    patches.push({
      mode,
      deviceId: device.id,
      value: normalizedValue,
      revision: targetPatchRevision,
    });
    pendingTargetPatches.set(homeId, patches);
    try {
      await persistPendingTargetPatches(homeId);
      if (state.loadedModeHomeId === homeId) renderPriorities(state.latestDevices);
    } catch (error) {
      await logSettingsError('Failed to update device target', error, 'device detail');
      await showToastError(error, 'Failed to update device target.');
    }
  });
};

const buildDeviceDetailModeRow = (
  catalog: DetailModeCatalog,
  mode: string,
  device: SettingsUiDeviceDetailItem,
  homeId: string,
  draft: DetailModeDraft,
) => {
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

  if (mode === catalog.activeMode) {
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
  prioritySpan.textContent = getPriorityLabel(catalog, mode, device.id);
  nameWrap.appendChild(prioritySpan);

  const target = getPrimaryTargetCapability(device.targets);
  const tempInput = buildDeviceDetailModeInput(mode, device, target, catalog);
  bindDeviceDetailModeInput({ tempInput, mode, device, target, draft, homeId });

  row.append(nameWrap, tempInput);
  return row;
};

let detailModeGeneration = 0;

const loadDetailCatalog = async (homeId: string): Promise<DetailModeCatalog> => {
  const [activeRaw, prioritiesRaw, targetsRaw] = await Promise.all([
    getSetting(homeScopedSettingsKey(OPERATING_MODE_SETTING, homeId)),
    getSetting(homeScopedSettingsKey(CAPACITY_PRIORITIES, homeId)),
    getSetting(homeScopedSettingsKey(MODE_DEVICE_TARGETS, homeId)),
  ]);
  const allowAbsent = homeId === MAIN_HOME_ID;
  const priorities = (prioritiesRaw === null || prioritiesRaw === undefined) && allowAbsent
    ? new ModePriorityCatalog()
    : readModePriorityCatalog(prioritiesRaw);
  const targets = readModeDeviceTargetsSetting(targetsRaw, allowAbsent);
  if (priorities === null || targets === null) throw new Error('Mode catalog unavailable');
  return {
    activeMode: typeof activeRaw === 'string' && activeRaw.trim() ? activeRaw : 'Home',
    priorities,
    targets,
  };
};

const paintDetailCatalog = (
  catalog: DetailModeCatalog,
  device: SettingsUiDeviceDetailItem,
  homeId: string,
): void => {
  if (!deviceDetailModes) return;
  deviceDetailModes.replaceChildren();
  const draft: DetailModeDraft = { current: catalog };
  getAllModes(catalog).forEach((mode) => {
    deviceDetailModes.appendChild(buildDeviceDetailModeRow(catalog, mode, device, homeId, draft));
  });
};

export const renderDeviceDetailModes = (device: SettingsUiDeviceDetailItem) => {
  if (!deviceDetailModes) return;
  while (deviceDetailModes.firstChild) deviceDetailModes.removeChild(deviceDetailModes.firstChild);

  // Per-mode temperature targets only apply to thermal devices. On/off and
  // stepped-load devices have no target temperature to set per mode, so hide
  // the whole section rather than render an empty-state placeholder.
  const supports = supportsTemperatureDevice(device);
  if (deviceDetailModesSection) deviceDetailModesSection.hidden = !supports;
  if (!supports) return;
  if (modesHelpEl) {
    modesHelpEl.textContent = !supportsPowerDevice(device)
      ? DEVICE_POWER_SUPPORT_REASON
      : MODES_HELP_DISABLED;
    if (supportsTemperatureControlDevice(device)) modesHelpEl.textContent = MODES_HELP_ACTIVE;
  }

  detailModeGeneration += 1;
  const generation = detailModeGeneration;
  const homeId = getHomeIdForUiDevice(device.id);
  if (state.loadedModeHomeId === homeId) {
    paintDetailCatalog({
      activeMode: state.activeMode,
      priorities: state.modePriorityCatalog,
      targets: state.modeTargets,
    }, device, homeId);
    return;
  }
  void loadDetailCatalog(homeId).then((catalog) => {
    if (generation !== detailModeGeneration || !deviceDetailModes) return;
    paintDetailCatalog(catalog, device, homeId);
  }).catch((error: unknown) => {
    void logSettingsError('Failed to load device modes', error, 'device detail');
  });
};
