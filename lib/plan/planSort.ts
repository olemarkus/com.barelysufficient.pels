import type { DevicePlanDevice } from './planTypes';

export function sortByPriorityAsc(devices: DevicePlanDevice[]): DevicePlanDevice[] {
  return stableSort(devices, compareByPriorityAsc);
}

export function sortByPriorityDesc(devices: DevicePlanDevice[]): DevicePlanDevice[] {
  return stableSort(devices, compareByPriorityDesc);
}

function stableSort(
  devices: DevicePlanDevice[],
  compare: (a: DevicePlanDevice, b: DevicePlanDevice) => number,
): DevicePlanDevice[] {
  return devices.slice().sort(compare);
}

/**
 * Final, deterministic tiebreak shared by shed and restore arbitration. Devices
 * with no stored priority all collapse to the same `priority ?? default`
 * bucket; without a total order, their relative ranking depends on input order
 * (and shed vs restore could disagree). Comparing the raw `id` with `<`/`>`
 * gives a locale-independent, total order so the same device always wins on
 * both sides. Equal ids return 0 (identity).
 */
export function compareDeviceIdAsc(a: { id: string }, b: { id: string }): number {
  if (a.id < b.id) return -1;
  if (a.id > b.id) return 1;
  return 0;
}

function compareByPriorityAsc(a: DevicePlanDevice, b: DevicePlanDevice): number {
  const byPriority = (a.priority ?? 999) - (b.priority ?? 999);
  if (byPriority !== 0) return byPriority;
  return compareDeviceIdAsc(a, b);
}

function compareByPriorityDesc(a: DevicePlanDevice, b: DevicePlanDevice): number {
  const byPriority = (b.priority ?? 0) - (a.priority ?? 0);
  if (byPriority !== 0) return byPriority;
  return compareDeviceIdAsc(a, b);
}
