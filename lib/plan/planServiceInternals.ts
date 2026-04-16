import type { DevicePlan, PlanRebuildOutcome } from './planTypes';

export const STATUS_POWER_BUCKET_MS = 30 * 1000;

export const createPlanRebuildOutcome = (isDryRun: boolean): PlanRebuildOutcome => ({
  buildMs: 0,
  changeMs: 0,
  snapshotMs: 0,
  snapshotWriteMs: 0,
  statusMs: 0,
  statusWriteMs: 0,
  applyMs: 0,
  actionChanged: false,
  detailChanged: false,
  metaChanged: false,
  appliedActions: false,
  deviceWriteCount: 0,
  hadShedding: false,
  isDryRun,
  failed: false,
});

export const hasShedding = (plan: DevicePlan): boolean => (
  plan.devices.some((device) => device.plannedState === 'shed')
);
