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
 * Final, deterministic defensive tiebreak shared by shed and restore
 * arbitration. Production plan inputs already carry unique active-home ranks,
 * but these lower-level helpers also accept partial/legacy test and recovery
 * shapes. Comparing the raw `id` with `<`/`>` keeps those callers independent
 * of input order and makes shed and restore agree. Equal ids return 0.
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
