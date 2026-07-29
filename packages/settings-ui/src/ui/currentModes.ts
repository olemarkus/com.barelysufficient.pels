import {
  CAPACITY_PRIORITIES,
  MAIN_HOME_ID,
  MODE_CATALOG_INITIALIZED,
  MODE_DEVICE_TARGETS,
  OPERATING_MODE_SETTING,
  homeScopedSettingsKey,
} from '../../../contracts/src/settingsKeys.ts';
import { DEFAULT_MODE_NAME } from '../../../shared-domain/src/modeLabels.ts';
import { MAIN_HOME_NAME } from '../../../shared-domain/src/homeScopeCopy.ts';
import { getSetting, setSetting } from './homey.ts';
import { getHomeScope, refreshHomeScope, subscribeToHomeScope } from './homeScope.ts';
import { logSettingsError } from './logging.ts';
import { showToast, showToastError } from './toast.ts';
import { parseModeNumberMap } from './modeCatalogMaps.ts';
import {
  renderCurrentModesView,
  type CurrentModeRow,
} from './views/CurrentModesView.tsx';

const MOUNT_ID = 'current-modes-root';
let generation = 0;
let latestRows: readonly CurrentModeRow[] = [];
const activeModeWriteTails = new Map<string, Promise<void>>();

const persistActiveModeInOrder = (
  homeId: string,
  task: () => Promise<void>,
): void => {
  const previous = activeModeWriteTails.get(homeId) ?? Promise.resolve();
  const next = previous
    .catch(() => undefined)
    .then(task)
    .finally(() => {
      if (activeModeWriteTails.get(homeId) === next) activeModeWriteTails.delete(homeId);
    });
  activeModeWriteTails.set(homeId, next);
};

const readRow = async (homeId: string, homeName: string): Promise<CurrentModeRow> => {
  try {
    const [activeRaw, prioritiesRaw, targetsRaw, initializedRaw] = await Promise.all([
      getSetting(homeScopedSettingsKey(OPERATING_MODE_SETTING, homeId)),
      getSetting(homeScopedSettingsKey(CAPACITY_PRIORITIES, homeId)),
      getSetting(homeScopedSettingsKey(MODE_DEVICE_TARGETS, homeId)),
      getSetting(homeScopedSettingsKey(MODE_CATALOG_INITIALIZED, homeId)),
    ]);
    // A just-created meter area can appear in /ui_homes one settings event
    // before its runtime bundle persists the initial catalog. Treat the
    // completely unwritten state as the real default Home mode. A partial or
    // malformed catalog remains unavailable so we never hide corruption.
    const isAbsent = (value: unknown): boolean => value === null || value === undefined;
    const catalogUnwritten = homeId !== MAIN_HOME_ID
      && isAbsent(prioritiesRaw)
      && isAbsent(targetsRaw)
      && isAbsent(activeRaw)
      && isAbsent(initializedRaw);
    if (homeId !== MAIN_HOME_ID && !catalogUnwritten && initializedRaw !== true) {
      throw new Error('Mode catalog unavailable');
    }
    const priorities = catalogUnwritten
      ? { [DEFAULT_MODE_NAME]: {} }
      : parseModeNumberMap(prioritiesRaw, homeId === MAIN_HOME_ID);
    const targets = catalogUnwritten
      ? { [DEFAULT_MODE_NAME]: {} }
      : parseModeNumberMap(targetsRaw, homeId === MAIN_HOME_ID);
    if (priorities === null || targets === null) throw new Error('Mode catalog unavailable');
    const modes = new Set([...Object.keys(priorities), ...Object.keys(targets)]);
    const active = typeof activeRaw === 'string' && activeRaw.trim()
      ? activeRaw.trim()
      : DEFAULT_MODE_NAME;
    modes.add(active);
    return {
      homeId,
      homeName,
      mode: active,
      modes: [...modes].sort((left, right) => left.localeCompare(right)),
      unavailable: false,
    };
  } catch {
    return {
      homeId,
      homeName,
      mode: DEFAULT_MODE_NAME,
      modes: [DEFAULT_MODE_NAME],
      unavailable: true,
    };
  }
};

const renderRows = (rows: readonly CurrentModeRow[]): void => {
  latestRows = rows;
  const mount = document.getElementById(MOUNT_ID);
  if (!mount) return;
  renderCurrentModesView(mount, {
    rows,
    onChange: (homeId, mode) => {
      const previousMode = latestRows.find((row) => row.homeId === homeId)?.mode;
      renderRows(latestRows.map((row) => (
        row.homeId === homeId ? { ...row, mode } : row
      )));
      persistActiveModeInOrder(homeId, async () => {
        try {
          await setSetting(homeScopedSettingsKey(OPERATING_MODE_SETTING, homeId), mode);
        } catch (error) {
          renderRows(latestRows.map((row) => (
            row.homeId === homeId && row.mode === mode && previousMode
              ? { ...row, mode: previousMode }
              : row
          )));
          await logSettingsError('Failed to set active mode', error, 'currentModes');
          void showToastError(error as Error, 'Failed to set active mode.');
          return;
        }
        void showToast(`Active mode set to ${mode}`, 'ok');
      });
    },
  });
};

export const applyCurrentModeRename = (
  homeId: string,
  oldName: string,
  newName: string,
): void => {
  renderRows(latestRows.map((row) => {
    if (row.homeId !== homeId) return row;
    return {
      ...row,
      mode: row.mode === oldName ? newName : row.mode,
      modes: row.modes
        .map((mode) => (mode === oldName ? newName : mode))
        .sort((left, right) => left.localeCompare(right)),
    };
  }));
};

export const refreshCurrentModes = async (): Promise<void> => {
  generation += 1;
  const run = generation;
  const scope = getHomeScope();
  const homes = [
    { homeId: MAIN_HOME_ID, homeName: MAIN_HOME_NAME },
    ...(scope.runtimeActive ? scope.areas.map((area) => ({
      homeId: area.homeId,
      homeName: area.name,
    })) : []),
  ];
  const rows = await Promise.all(homes.map((home) => readRow(home.homeId, home.homeName)));
  if (run !== generation) return;
  renderRows(rows);
};

export const initCurrentModes = (): void => {
  subscribeToHomeScope(() => { void refreshCurrentModes(); });
  void refreshHomeScope().then(() => refreshCurrentModes());
};
