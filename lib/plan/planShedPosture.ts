import type { DevicePlan } from './planTypes';

export function hasPlannedShedDevices(plan: Pick<DevicePlan, 'devices'>): boolean {
  return plan.devices.some((device) => device.plannedState === 'shed');
}
