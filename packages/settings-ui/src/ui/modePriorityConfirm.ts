import { CAPACITY_PRIORITIES, homeScopedSettingsKey } from '../../../contracts/src/settingsKeys.ts';
import { getHomeScope } from './homeScope.ts';
import { getSettingFresh } from './homey.ts';
import { countUnplacedDevices, hasPlaceInOrder } from './modePriorityPlace.ts';
import { renderPriorities, savePriorities } from './modes.ts';
import { notifySetupPathChange } from './setupPathFacts.ts';
import { state } from './state.ts';

/**
 * "Keep this order", on the Modes screen.
 *
 * That screen always shows an order, including for devices nobody placed, and
 * the only way to make it the owner's was to drag something. An owner who looks
 * and is content had no way to say so — so anything that asks "have you chosen
 * an order?" (the setup path does) would have asked them forever. The notice
 * shows only while a listed device is unplaced, and its button saves the order
 * exactly as shown: the same write a drag ends with.
 *
 * A controller of its own, driven by what `modes.ts` already exports and by the
 * list element itself, because `modes.ts` sits at its line ceiling and this is
 * not its concern anyway.
 */
const NOTICE_ID = 'priority-unplaced';
const KEEP_BUTTON_ID = 'priority-keep-order';
const LIST_ID = 'priority-list';

const listedDeviceIds = (list: HTMLElement): string[] => (
  [...list.querySelectorAll<HTMLElement>('[data-device-id]')].flatMap((row) => row.dataset.deviceId ?? [])
);

const syncNotice = (list: HTMLElement): void => {
  const notice = document.getElementById(NOTICE_ID);
  if (notice) notice.hidden = countUnplacedDevices(listedDeviceIds(list), state.editingMode) === 0;
};

/**
 * Whether the order on screen is what Homey now holds. `savePriorities` reports
 * a failed write with a toast and then resolves normally, having already placed
 * every device in `state`, so its resolving proves nothing. The persisted map is
 * read back past the cache; an unreadable answer counts as not saved.
 */
const isShownOrderPersisted = async (deviceIds: readonly string[], mode: string): Promise<boolean> => {
  const key = homeScopedSettingsKey(CAPACITY_PRIORITIES, getHomeScope().selectedHomeId);
  const [read] = await Promise.allSettled([getSettingFresh(key)]);
  if (read.status !== 'fulfilled' || typeof read.value !== 'object' || read.value === null) return false;
  const persisted = (read.value as Record<string, Record<string, unknown> | undefined>)[mode] ?? {};
  return deviceIds.every((id) => hasPlaceInOrder(persisted[id]));
};

const keepShownOrder = async (list: HTMLElement): Promise<void> => {
  const mode = state.editingMode;
  const deviceIds = listedDeviceIds(list);
  // `savePriorities` writes into the mode's own map, so the way back is a copy.
  const before = structuredClone(state.capacityPriorities);
  await savePriorities();
  if (!await isShownOrderPersisted(deviceIds, mode)) {
    // The write did not land. Put `state` back, so the notice stays and the
    // setup path does not count an order nobody managed to save.
    state.capacityPriorities = before;
  }
  renderPriorities(state.latestDevices);
  syncNotice(list);
  notifySetupPathChange();
};

export const initModePriorityConfirm = (): void => {
  const list = document.getElementById(LIST_ID);
  if (!list) return;

  // `renderPriorities` rebuilds the list's children, for a new mode, a new
  // device list or a changed scope alike. Watching the element covers them all.
  new MutationObserver(() => syncNotice(list)).observe(list, { childList: true });

  // A drag places every listed device. Sortable dispatches `end` on the list
  // BEFORE it calls the `onEnd` that saves, and that save updates `state`
  // synchronously, so one macrotask later the new places are readable.
  list.addEventListener('end', () => {
    setTimeout(() => {
      syncNotice(list);
      notifySetupPathChange();
    }, 0);
  });

  document.getElementById(KEEP_BUTTON_ID)?.addEventListener('click', () => { void keepShownOrder(list); });
  syncNotice(list);
};
