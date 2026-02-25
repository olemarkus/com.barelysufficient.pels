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

function compareByPriorityAsc(a: DevicePlanDevice, b: DevicePlanDevice): number {
  return (a.priority ?? 999) - (b.priority ?? 999);
}

function compareByPriorityDesc(a: DevicePlanDevice, b: DevicePlanDevice): number {
  return (b.priority ?? 0) - (a.priority ?? 0);
}
