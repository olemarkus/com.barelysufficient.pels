import { addPerfDuration, incPerfCounter } from '../utils/perfCounters';
import { recordPlanRebuildTrace } from '../utils/planRebuildTrace';
import type { DevicePlan, PlanRebuildOutcome } from './planTypes';

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
  hadShedding: false,
  isDryRun,
  failed: false,
});

export const buildPlanHeadroomLogFields = (
  plan: DevicePlan | null,
): Record<string, number | boolean | null> => {
  const meta = plan?.meta;
  if (!meta) return {};
  const softHeadroomKw = typeof meta.headroomKw === 'number' ? meta.headroomKw : null;
  const hardCapHeadroomKw = typeof meta.hardCapHeadroomKw === 'number' ? meta.hardCapHeadroomKw : null;
  const shortfallBudgetHeadroomKw = typeof meta.shortfallBudgetHeadroomKw === 'number'
    ? meta.shortfallBudgetHeadroomKw
    : null;
  return {
    totalKw: typeof meta.totalKw === 'number' ? meta.totalKw : null,
    softLimitKw: typeof meta.softLimitKw === 'number' ? meta.softLimitKw : null,
    softHeadroomKw,
    shortfallBudgetThresholdKw: typeof meta.shortfallBudgetThresholdKw === 'number'
      ? meta.shortfallBudgetThresholdKw
      : null,
    shortfallBudgetHeadroomKw,
    hardCapHeadroomKw,
    hardCapBreached: hardCapHeadroomKw !== null ? hardCapHeadroomKw < 0 : false,
    capacityShortfall: meta.capacityShortfall === true,
  };
};

export const recordPlanRebuildMetrics = (params: {
  reason: string;
  queueWaitMs: number;
  queueDepth: number;
  rebuildStart: number;
  outcome: PlanRebuildOutcome;
}): void => {
  const {
    reason, queueWaitMs, queueDepth, rebuildStart, outcome,
  } = params;
  const totalMs = Date.now() - rebuildStart;
  addPerfDuration('plan_rebuild_ms', totalMs);
  addPerfDuration('plan_rebuild_build_ms', outcome.buildMs);
  addPerfDuration('plan_rebuild_change_ms', outcome.changeMs);
  addPerfDuration('plan_rebuild_snapshot_ms', outcome.snapshotMs);
  addPerfDuration('plan_rebuild_status_ms', outcome.statusMs);
  addPerfDuration('plan_rebuild_status_write_ms', outcome.statusWriteMs);
  addPerfDuration('plan_rebuild_apply_ms', outcome.applyMs);
  incPerfCounter('plan_rebuild_total');
  recordPlanRebuildTrace({
    reason,
    queueDepth,
    queueWaitMs,
    buildMs: outcome.buildMs,
    changeMs: outcome.changeMs,
    snapshotMs: outcome.snapshotMs,
    statusMs: outcome.statusMs,
    statusWriteMs: outcome.statusWriteMs,
    applyMs: outcome.applyMs,
    totalMs,
    actionChanged: outcome.actionChanged,
    detailChanged: outcome.detailChanged,
    metaChanged: outcome.metaChanged,
    isDryRun: outcome.isDryRun,
    appliedActions: outcome.appliedActions,
    deviceWriteCount: outcome.deviceWriteCount,
    commandRequestCount: outcome.commandRequestCount,
    hadShedding: outcome.hadShedding,
    failed: outcome.failed,
  });
};

export const getPlanRebuildLogLevel = (
  reason: string,
  durationMs: number,
  outcome: PlanRebuildOutcome,
): 'info' | 'debug' | null => {
  if (outcome.failed) return 'info';
  if (outcome.appliedActions) return 'info';
  if (durationMs >= SLOW_PLAN_REBUILD_LOG_THRESHOLD_MS) return 'info';
  if (reason === 'initial' || reason === 'startup_snapshot_bootstrap' || reason.startsWith('settings:')) {
    return 'info';
  }
  // actionChanged-only: plan decisions changed but no commands were issued — plan debug topic
  if (outcome.actionChanged) return 'debug';
  return null;
};
