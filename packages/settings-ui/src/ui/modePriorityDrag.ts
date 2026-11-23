import Sortable from 'sortablejs';
import { groupModePriorityDeviceIds } from '../../../shared-domain/src/modePriorities.ts';
import { allowLastResortPriorityMove } from './devicePowerSetup.ts';
import { priorityList } from './dom.ts';
import { isPriorityContextCurrent, savePriorities } from './modePrioritySave.ts';

export const getPriorityRows = (): HTMLElement[] => (
  Array.from(priorityList?.querySelectorAll<HTMLElement>('.device-row') || [])
);

const moveSharedPriorityRows = (movedDeviceId: string | undefined): void => {
  const rows = getPriorityRows();
  const rowsById = new Map(rows.map((row) => [row.dataset.deviceId!, row]));
  const ordered = groupModePriorityDeviceIds([...rowsById.keys()],
    (id) => rowsById.get(id)?.dataset.priorityGroup, movedDeviceId);
  if (ordered.every((id, index) => rows[index]?.dataset.deviceId === id)) return;
  for (const id of ordered) priorityList.appendChild(rowsById.get(id)!);
};

let sortableInstance: Sortable | null = null;

export const initPriorityDrag = (refreshBadges: () => void, renderRows: () => void): void => {
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
    onMove: ({ dragged, related }) => allowLastResortPriorityMove(dragged, related),
    onEnd: async ({ item }) => {
      moveSharedPriorityRows(item.dataset.deviceId);
      refreshBadges();
      const outcome = await savePriorities();
      if (outcome.status !== 'saved') {
        renderRows();
        return;
      }
      if (!isPriorityContextCurrent(outcome.homeId, outcome.mode, outcome.deviceIds)) return;
      renderRows();
    },
  });
};
