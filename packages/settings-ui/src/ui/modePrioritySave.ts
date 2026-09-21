import { CAPACITY_PRIORITIES, MAIN_HOME_ID, homeScopedSettingsKey } from '../../../contracts/src/settingsKeys.ts';
import { resolveModeName } from '../../../shared-domain/src/modeLabels.ts';
import { priorityList } from './dom.ts';
import { getHomeScope } from './homeScope.ts';
import { getSetting, setSetting } from './homey.ts';
import { logSettingsError } from './logging.ts';
import { isModeMutationLocked, serializeModeCatalogWrite } from './modeRename.ts';
import { classifyModeNumberMap } from './modeCatalogMaps.ts';
import { state } from './state.ts';
import { showToast, showToastError } from './toast.ts';

export type PrioritySaveOutcome =
  | {
    status: 'saved';
    homeId: string;
    mode: string;
    deviceIds: readonly string[];
  }
  | { status: 'not-saved' };

const NOT_SAVED: PrioritySaveOutcome = { status: 'not-saved' };

type ShownPriorityOrderRead =
  | { status: 'resolved'; deviceIds: string[] }
  | { status: 'invalid' };

const readShownPriorityOrder = (): ShownPriorityOrderRead => {
  const deviceIds: string[] = [];
  for (const row of priorityList.querySelectorAll<HTMLElement>('.device-row')) {
    const deviceId = row.dataset.deviceId;
    if (typeof deviceId !== 'string' || deviceId.length === 0) return { status: 'invalid' };
    deviceIds.push(deviceId);
  }
  return { status: 'resolved', deviceIds };
};

const haveSameDeviceOrder = (
  left: readonly string[],
  right: readonly string[],
): boolean => left.length === right.length && left.every((deviceId, index) => deviceId === right[index]);

const isShownDeviceOrder = (deviceIds: readonly string[]): boolean => {
  const shown = readShownPriorityOrder();
  return shown.status === 'resolved' && haveSameDeviceOrder(shown.deviceIds, deviceIds);
};

export const isPriorityContextCurrent = (
  homeId: string,
  mode: string,
  deviceIds: readonly string[],
): boolean => (
  getHomeScope().selectedHomeId === homeId
  && state.loadedModeHomeId === homeId
  && state.editingMode === mode
  && isShownDeviceOrder(deviceIds)
);

export const savePriorities = async (): Promise<PrioritySaveOutcome> => {
  const homeId = getHomeScope().selectedHomeId;
  if (state.loadedModeHomeId !== homeId || isModeMutationLocked(homeId)) return NOT_SAVED;
  const mode = resolveModeName(state.editingMode);
  const shown = readShownPriorityOrder();
  if (shown.status === 'invalid') return NOT_SAVED;
  const { deviceIds } = shown;
  const priorityUpdates = Object.fromEntries(deviceIds.map((deviceId, index) => [deviceId, index + 1]));
  try {
    await serializeModeCatalogWrite(homeId, async () => {
      const key = homeScopedSettingsKey(CAPACITY_PRIORITIES, homeId);
      const latest = classifyModeNumberMap(await getSetting(key), homeId === MAIN_HOME_ID);
      if (latest.state === 'unavailable') throw new Error('Priority catalog unavailable');
      await setSetting(key, {
        ...latest.value,
        [mode]: {
          ...(latest.value[mode] ?? {}),
          ...priorityUpdates,
        },
      });
    });
  } catch (error) {
    await logSettingsError('Failed to save priorities', error, 'savePriorities');
    void showToastError(error, 'Failed to save priorities.');
    return NOT_SAVED;
  }
  const outcome: PrioritySaveOutcome = {
    status: 'saved', homeId, mode, deviceIds,
  };
  if (!isPriorityContextCurrent(homeId, mode, deviceIds)) return outcome;
  state.capacityPriorities = {
    ...state.capacityPriorities,
    [mode]: {
      ...(state.capacityPriorities[mode] ?? {}),
      ...priorityUpdates,
    },
  };
  void showToast(`Priorities saved for ${mode}.`, 'ok');
  return outcome;
};
