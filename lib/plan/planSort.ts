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
  return devices.reduce((sorted, device) => insertSorted(sorted, device, compare), [] as DevicePlanDevice[]);
}

function insertSorted(
  list: DevicePlanDevice[],
  item: DevicePlanDevice,
  compare: (a: DevicePlanDevice, b: DevicePlanDevice) => number,
): DevicePlanDevice[] {
  const idx = list.findIndex((existing) => compare(item, existing) < 0);
  if (idx === -1) return [...list, item];
  return [...list.slice(0, idx), item, ...list.slice(idx)];
}

function compareByPriorityAsc(a: DevicePlanDevice, b: DevicePlanDevice): number {
  return (a.priority ?? 999) - (b.priority ?? 999);
}

function compareByPriorityDesc(a: DevicePlanDevice, b: DevicePlanDevice): number {
  return (b.priority ?? 0) - (a.priority ?? 0);
}
