import { getHomeScope } from './homeScope.ts';
import { countUnplacedDevices } from './modePriorityPlace.ts';
import { renderPriorities } from './modes.ts';
import { isPriorityContextCurrent, savePriorities } from './modePrioritySave.ts';
import { notifySetupPathChange } from './setupPathFacts.ts';
import { state } from './state.ts';
import { resolveModeName } from '../../../shared-domain/src/modeLabels.ts';

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

type ListedDeviceIdsRead =
  | { state: 'resolved'; deviceIds: string[] }
  | { state: 'invalid' };

const readListedDeviceIds = (list: HTMLElement): ListedDeviceIdsRead => {
  const deviceIds: string[] = [];
  for (const row of list.querySelectorAll<HTMLElement>('.device-row')) {
    const deviceId = row.dataset.deviceId;
    if (typeof deviceId !== 'string' || deviceId.length === 0) return { state: 'invalid' };
    deviceIds.push(deviceId);
  }
  return { state: 'resolved', deviceIds };
};

const syncNotice = (list: HTMLElement): void => {
  const notice = document.getElementById(NOTICE_ID);
  const read = readListedDeviceIds(list);
  if (notice && read.state === 'resolved') {
    notice.hidden = countUnplacedDevices(read.deviceIds, resolveModeName(state.editingMode)) === 0;
  }
};

const keepShownOrder = async (list: HTMLElement): Promise<void> => {
  const homeId = getHomeScope().selectedHomeId;
  const mode = resolveModeName(state.editingMode);
  const listed = readListedDeviceIds(list);
  if (listed.state === 'invalid') return;
  const { deviceIds } = listed;
  const outcome = await savePriorities();
  if (outcome.status !== 'saved') return;
  if (!isPriorityContextCurrent(homeId, mode, deviceIds)) return;
  if (
    (
      outcome.homeId !== homeId
      || outcome.mode !== mode
      || outcome.deviceIds.length !== deviceIds.length
      || outcome.deviceIds.some((deviceId, index) => deviceId !== deviceIds[index])
    )
  ) return;
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

  document.getElementById(KEEP_BUTTON_ID)?.addEventListener('click', () => { void keepShownOrder(list); });
  syncNotice(list);
};
