import type { DevicePlan } from './planTypes';

export const STATUS_POWER_BUCKET_MS = 30 * 1000;

export const hasShedding = (plan: DevicePlan): boolean => (
  plan.devices.some((device) => device.plannedState === 'shed')
);
