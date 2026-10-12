import { addPerfDuration, incPerfCounter } from '../utils/perfCounters';
import { recordPlanRebuildTrace } from '../utils/planRebuildTrace';
import type { DevicePlan } from './planTypes';
import type { PlanRebuildOutcome } from '../planContract/planActuationResult';
import type { PlanRebuildTrigger } from './planRebuildTrigger';

const SLOW_PLAN_REBUILD_LOG_THRESHOLD_MS = 1500;

export const createPlanRebuildOutcome = (isDryRun: boolean): PlanRebuildOutcome => ({
  buildMs: 0,
  changeMs: 0,
  snapshotMs: 0,
  statusMs: 0,
  statusWriteMs: 0,
  applyMs: 0,
  actionChanged: false,
  detailChanged: false,
  metaChanged: false,
  appliedActions: false,
  deviceWriteCount: 0,
  commandRequestCount: 0,
  deviceApplyFailureCount: 0,
  hadShedding: false,
  isDryRun,
  failed: false,
  gated: false,
});

export const buildPlanHeadroomLogFields = (
  plan: DevicePlan | null,
): Record<string, number | boolean | null> => {
  const meta = plan?.meta;
  if (!meta) return {};
  // The three distances exist only on a measured meta (`PlanMeasuredMetaFields`);
  // the unmeasured build logs them as null rather than a stand-in number. One
  // branch on the signal; the base fields are required and read directly.
  const measured = meta.powerIsMeasured
    ? {
      softHeadroomKw: meta.headroomKw,
      shortfallBudgetHeadroomKw: meta.shortfallBudgetHeadroomKw,
      hardCapHeadroomKw: meta.hardCapHeadroomKw,
      hardCapBreached: meta.hardCapHeadroomKw !== null && meta.hardCapHeadroomKw < 0,
    }
    : {
      softHeadroomKw: null, shortfallBudgetHeadroomKw: null, hardCapHeadroomKw: null, hardCapBreached: null,
    };
  return {
    totalKw: meta.totalKw,
    softLimitKw: meta.softLimitKw,
    shortfallBudgetThresholdKw: meta.shortfallBudgetThresholdKw,
    ...measured,
    capacityShortfall: meta.capacityShortfall,
  };
};

export const recordPlanRebuildMetrics = (
  reason: string,
  queueWaitMs: number,
  queueDepth: number,
  rebuildStart: number,
  outcome: PlanRebuildOutcome,
): void => {
  const endedAtMs = Date.now();
  const totalMs = endedAtMs - rebuildStart;
  addPerfDuration('plan_rebuild_ms', totalMs);
  addPerfDuration('plan_rebuild_build_ms', outcome.buildMs);
  addPerfDuration('plan_rebuild_change_ms', outcome.changeMs);
  addPerfDuration('plan_rebuild_snapshot_ms', outcome.snapshotMs);
  addPerfDuration('plan_rebuild_status_ms', outcome.statusMs);
  addPerfDuration('plan_rebuild_status_write_ms', outcome.statusWriteMs);
  addPerfDuration('plan_rebuild_apply_ms', outcome.applyMs);
  incPerfCounter('plan_rebuild_total');
  // A gated rebuild never reaches here.
  const { gated: _gated, ...measured } = outcome;
  recordPlanRebuildTrace({
    ...measured, reason, queueDepth, queueWaitMs, totalMs, endedAtMs,
  });
};

export const getPlanRebuildLogLevel = (
  trigger: PlanRebuildTrigger,
  durationMs: number,
  outcome: PlanRebuildOutcome,
): 'info' | 'debug' | null => {
  if (outcome.failed) return 'info';
  if (outcome.appliedActions) return 'info';
  if (durationMs >= SLOW_PLAN_REBUILD_LOG_THRESHOLD_MS) return 'info';
  if (trigger === 'initial' || trigger === 'startup_snapshot_bootstrap' || trigger === 'settings') {
    return 'info';
  }
  // actionChanged-only: plan decisions changed but no commands were issued — plan debug topic
  if (outcome.actionChanged) return 'debug';
  return null;
};
