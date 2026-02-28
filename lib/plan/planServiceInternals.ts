import { buildPelsStatus } from '../core/pelsStatus';
import type { DevicePlan } from './planTypes';

export const STATUS_POWER_BUCKET_MS = 30 * 1000;

export type PlanChangeSet = {
  actionSignature: string;
  detailSignature: string;
  metaSignature: string;
  actionChanged: boolean;
  detailChanged: boolean;
  metaChanged: boolean;
};

export type PlanSnapshotWriteReason = 'action_changed' | 'detail_changed' | 'meta_only';
export type PelsStatusWriteReason = 'initial' | 'action_changed' | 'throttle';

export type StatusPlanChanges = Pick<
  PlanChangeSet,
  'actionChanged' | 'actionSignature' | 'detailSignature' | 'metaSignature'
>;

export type PlanRebuildOutcome = {
  buildMs: number;
  changeMs: number;
  snapshotMs: number;
  snapshotWriteMs: number;
  statusMs: number;
  statusWriteMs: number;
  applyMs: number;
  actionChanged: boolean;
  detailChanged: boolean;
  metaChanged: boolean;
  appliedActions: boolean;
  hadShedding: boolean;
  isDryRun: boolean;
  failed: boolean;
};

export type PelsStatusComputation = {
  result: ReturnType<typeof buildPelsStatus>;
  statusJson: string;
};

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
  hadShedding: false,
  isDryRun,
  failed: false,
});

export const hasShedding = (plan: DevicePlan): boolean => (
  plan.devices.some((device) => device.plannedState === 'shed')
);
