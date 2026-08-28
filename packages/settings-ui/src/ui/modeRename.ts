import {
  CAPACITY_PRIORITIES,
  MODE_ALIASES,
  MODE_DEVICE_TARGETS,
  OPERATING_MODE_SETTING,
  homeScopedSettingsKey,
} from '../../../contracts/src/settingsKeys.ts';
import { setSetting } from './homey.ts';
import { setModeEditorPending } from './modeEditor.ts';
import { state } from './state.ts';
import { assertWritableModeDeviceTargets } from './modeCatalogMaps.ts';

export type ModeRenameResult = 'duplicate' | 'noop' | 'renamed';
export type ModeCatalogDraft = {
  activeMode: string;
  editingMode: string;
  aliases: Record<string, string>;
  priorities: Record<string, Record<string, number>>;
  targets: Record<string, Record<string, number>>;
};
export type ModeRenameOutcome = {
  result: ModeRenameResult;
  catalog: ModeCatalogDraft;
};

const modeMutationHomes = new Set<string>();
const modeWriteTails = new Map<string, Promise<void>>();

export const isModeMutationLocked = (homeId: string): boolean => (
  modeMutationHomes.has(homeId)
);

export const serializeModeCatalogWrite = async (
  homeId: string,
  task: () => Promise<void>,
): Promise<void> => {
  const previous = modeWriteTails.get(homeId) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(task);
  modeWriteTails.set(homeId, next);
  try {
    await next;
  } finally {
    if (modeWriteTails.get(homeId) === next) modeWriteTails.delete(homeId);
  }
};

export const withModeMutationLock = async (
  homeId: string,
  task: () => Promise<void>,
): Promise<void> => {
  if (modeMutationHomes.has(homeId)) return;
  modeMutationHomes.add(homeId);
  setModeEditorPending(true);
  try {
    await serializeModeCatalogWrite(homeId, task);
  } finally {
    modeMutationHomes.delete(homeId);
    if (modeMutationHomes.size === 0) setModeEditorPending(false);
  }
};

const cloneNumberMap = (
  value: Record<string, Record<string, number>>,
): Record<string, Record<string, number>> => (
  Object.fromEntries(Object.entries(value).map(([mode, entries]) => [mode, { ...entries }]))
);

const cloneCatalog = (catalog: ModeCatalogDraft): ModeCatalogDraft => ({
  ...catalog,
  aliases: { ...catalog.aliases },
  priorities: cloneNumberMap(catalog.priorities),
  targets: cloneNumberMap(catalog.targets),
});

export const captureModeCatalog = (): ModeCatalogDraft => ({
  activeMode: state.activeMode,
  editingMode: state.editingMode,
  aliases: { ...state.modeAliases },
  priorities: cloneNumberMap(state.capacityPriorities),
  targets: cloneNumberMap(state.modeTargets),
});

export const applyModeCatalog = (catalog: ModeCatalogDraft): void => {
  state.activeMode = catalog.activeMode;
  state.editingMode = catalog.editingMode;
  state.modeAliases = catalog.aliases;
  state.capacityPriorities = catalog.priorities;
  state.modeTargets = catalog.targets;
};

/**
 * Persist one home's rename as an additive transition:
 * add new beside old → switch active/aliases → remove old. A failed step
 * therefore leaves an addressable target record instead of a mode that could
 * strand a temperature device at its lowered setpoint.
 */
export const persistModeRename = async (params: {
  oldName: string;
  newName: string;
  homeId: string;
  catalog: ModeCatalogDraft;
}): Promise<ModeRenameOutcome> => {
  const oldKey = params.oldName.trim();
  const newKey = params.newName.trim();
  const catalog = cloneCatalog(params.catalog);
  if (!oldKey || !newKey || oldKey === newKey) return { result: 'noop', catalog };
  if (catalog.priorities[newKey] || catalog.targets[newKey]) {
    return { result: 'duplicate', catalog };
  }

  const oldPriorities = catalog.priorities[oldKey];
  const oldTargets = catalog.targets[oldKey];
  if (oldPriorities) {
    catalog.priorities[newKey] = oldPriorities;
    delete catalog.priorities[oldKey];
  }
  if (oldTargets) {
    catalog.targets[newKey] = oldTargets;
    delete catalog.targets[oldKey];
  }
  catalog.aliases = Object.fromEntries(
    Object.entries(catalog.aliases)
      .map(([alias, target]) => [alias, target === oldKey ? newKey : target] as const),
  );
  catalog.aliases[oldKey.toLowerCase()] = newKey;

  const transitionPriorities = oldPriorities === undefined
    ? catalog.priorities
    : { ...catalog.priorities, [oldKey]: oldPriorities };
  const transitionTargets = oldTargets === undefined
    ? catalog.targets
    : { ...catalog.targets, [oldKey]: oldTargets };
  const key = (base: string): string => homeScopedSettingsKey(base, params.homeId);
  await setSetting(key(CAPACITY_PRIORITIES), transitionPriorities);
  await setSetting(key(MODE_DEVICE_TARGETS), assertWritableModeDeviceTargets(transitionTargets));
  if (catalog.activeMode === oldKey) {
    catalog.activeMode = newKey;
    await setSetting(key(OPERATING_MODE_SETTING), catalog.activeMode);
  }
  await setSetting(key(MODE_ALIASES), catalog.aliases);
  if (catalog.editingMode === oldKey) catalog.editingMode = newKey;
  await setSetting(key(CAPACITY_PRIORITIES), catalog.priorities);
  await setSetting(key(MODE_DEVICE_TARGETS), assertWritableModeDeviceTargets(catalog.targets));
  return { result: 'renamed', catalog };
};
