import type { DevicePlan, DevicePlanDevice } from './planTypes';

export function buildPlanSignature(plan: DevicePlan): string {
  return JSON.stringify(
    plan.devices.map((d) => ({
      id: d.id,
      plannedState: d.plannedState,
      plannedTarget: d.plannedTarget,
      currentState: d.currentState,
      reason: d.reason,
    })),
  );
}

export function buildPlanChangeLines(plan: DevicePlan): string[] {
  const headroom = typeof plan.meta.headroomKw === 'number' ? plan.meta.headroomKw : null;
  const changes = plan.devices
    .filter((d) => isChange(d))
    .reduce((sorted, device) => insertSorted(sorted, device, compareDevices), [] as DevicePlanDevice[]);
  return changes.map((device) => formatPlanChange(device, headroom));
}

function isChange(device: DevicePlanDevice): boolean {
  if (device.controllable === false) return false;
  const desiredPower = getDesiredPower(device);
  const samePower = desiredPower === device.currentState;
  const sameTarget = normalizeTarget(device.plannedTarget) === normalizeTarget(device.currentTarget);
  return !(samePower && sameTarget);
}

function getDesiredPower(device: DevicePlanDevice): 'on' | 'off' {
  if (device.plannedState !== 'shed') return 'on';
  return device.shedAction === 'set_temperature' ? 'on' : 'off';
}

function normalizeTarget(value: unknown): number | string | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return null;
  return String(value);
}

function formatPlanChange(device: DevicePlanDevice, headroom: number | null): string {
  const temp = `${formatTarget(device.currentTarget)}° -> ${formatTarget(device.plannedTarget)}°`;
  const nextPower = getPlannedPowerLabel(device);
  const power = `${device.currentState} -> ${nextPower}`;
  const powerInfo = typeof device.powerKw === 'number'
    ? `, est ${device.powerKw.toFixed(2)}kW`
    : '';
  const headroomInfo = typeof headroom === 'number'
    ? `, headroom ${headroom.toFixed(2)}kW`
    : '';
  const restoringHint = buildRestoreHint(device, nextPower, headroom);
  const reason = device.reason ?? 'n/a';
  return `${device.name}: temp ${temp}, power ${power}${powerInfo}${headroomInfo}, reason: ${reason}${restoringHint}`;
}

function formatTarget(value: unknown): string {
  if (typeof value === 'number' && Number.isFinite(value)) return value.toString();
  if (value === null || value === undefined) return '–';
  return String(value);
}

function getPlannedPowerLabel(device: DevicePlanDevice): string {
  if (device.plannedState !== 'shed') return 'on';
  if (device.shedAction === 'set_temperature') {
    return typeof device.plannedTarget === 'number'
      ? `set temp ${device.plannedTarget}°`
      : 'set temp';
  }
  return 'off';
}

function buildRestoreHint(device: DevicePlanDevice, nextPower: string, headroom: number | null): string {
  if (device.currentState !== 'off' || nextPower !== 'on') return '';
  const needed = typeof device.powerKw === 'number' ? device.powerKw : 1;
  const headroomInfo = typeof headroom === 'number' ? ` vs headroom ${headroom.toFixed(2)}kW` : '';
  return ` (restoring, needs ~${needed.toFixed(2)}kW${headroomInfo})`;
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

function compareDevices(a: DevicePlanDevice, b: DevicePlanDevice): number {
  const pa = a.priority ?? 999;
  const pb = b.priority ?? 999;
  if (pa !== pb) return pa - pb;
  return (a.name || '').localeCompare(b.name || '');
}
