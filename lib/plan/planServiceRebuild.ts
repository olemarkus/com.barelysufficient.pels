/**
 * Rebuild orchestration for `PlanService`. Extracted (slice: full builder
 * pipeline run) so the service file stays under the line ceiling while keeping
 * reconcile/sync sequencing alongside the public surface. These functions own
 * the WHEN-to-actuate sequencing of a single rebuild: build → stamp → track
 * changes → snapshot/status update → conditional apply → reconcile-snapshot
 * commit → completion metrics/log. They mutate `PlanService` state only through
 * the `PlanRebuildHost` seam so the service keeps its private fields. Behaviour
 * is identical to the former `PlanService.performPlanRebuild` and its private
 * helpers; the intent-queue serialization stays in `PlanService`.
 */
import { randomUUID } from 'node:crypto';
import { incPerfCounter } from '../utils/perfCounters';
import { recordOpRssDelta, safeRss } from '../utils/opRssTracker';
import { startRuntimeSpan } from '../utils/runtimeTrace';
import { normalizeError } from '../utils/errorUtils';
import { isFiniteNumber } from '../utils/appTypeGuards';
import { getLogger, withRebuildContext } from '../logging/logger';
import { buildPlanCapacityStateSummary, buildPlanDetailSignature } from './planLogging';
import { hasShedding } from './planServiceInternals';
import {
  buildPlanHeadroomLogFields,
  createPlanRebuildOutcome,
  getPlanRebuildLogLevel,
  recordPlanRebuildMetrics,
} from './planRebuildMetrics';
import { normalizePlanMeta } from './planStatusHelpers';
import { buildLiveStatePlan, canRefreshPlanSnapshotFromLiveState } from './planReconcileState';
import type { PlanServiceDeps } from './planServiceDeps';
import type {
  DevicePlan,
  PlanChangeSet,
  PlanRebuildOutcome,
  StatusPlanChanges,
} from './planTypes';
import type { PendingBinaryLiveDevice } from '../observer/pendingBinaryCommands';

const logger = getLogger('plan/service');

// State + collaborator seam onto `PlanService`. Built once in the service
// constructor (closures over its private fields), so rebuild orchestration
// reads/writes the live snapshot state without exposing it publicly.
export type PlanRebuildHost = {
  deps: PlanServiceDeps;
  getLatestPlanSnapshot: () => DevicePlan | null;
  setLatestPlanSnapshot: (plan: DevicePlan | null) => void;
  getLatestPlanSnapshotUpdatedAtMs: () => number | null;
  setLatestPlanSnapshotUpdatedAtMs: (ms: number | null) => void;
  getLatestReconcilePlanSnapshot: () => DevicePlan | null;
  setLatestReconcilePlanSnapshot: (plan: DevicePlan | null) => void;
  settleDevices: () => PendingBinaryLiveDevice[];
  trackChanges: (plan: DevicePlan, metaSignature: string) => PlanChangeSet;
  updatePlanSnapshot: (plan: DevicePlan, changes: PlanChangeSet) => void;
  updatePelsStatus: (plan: DevicePlan, changes?: StatusPlanChanges) => number;
  stampPlanGeneratedAt: (plan: DevicePlan, nowMs?: number) => DevicePlan;
  preservePlanGeneratedAt: (plan: DevicePlan, basePlan: DevicePlan) => DevicePlan;
  emitPlanUpdated: (plan: DevicePlan) => void;
};

export async function performPlanRebuild(
  host: PlanRebuildHost,
  params: { reason: string; queueWaitMs: number; queueDepth: number },
): Promise<PlanRebuildOutcome> {
  const { reason, queueWaitMs, queueDepth } = params;
  const isDryRun = host.deps.getCapacityDryRun();
  const rebuildId = `rb_${randomUUID()}`;
  const rebuildStart = Date.now();
  const rssBefore = safeRss();
  const stopSpan = startRuntimeSpan(`plan_rebuild(${reason})`);
  const outcome = createPlanRebuildOutcome(isDryRun);

  const run = async (): Promise<void> => {
    try {
      await executePlanRebuild(host, reason, isDryRun, outcome);
    } catch (error) {
      outcome.failed = true;
      incPerfCounter('plan_rebuild_failed_total');
      throw error;
    } finally {
      const durationMs = Date.now() - rebuildStart;
      recordPlanRebuildMetrics({
        reason, queueWaitMs, queueDepth, rebuildStart, outcome,
      });
      recordOpRssDelta('plan_rebuild_ms', rssBefore, safeRss());
      stopSpan();
      const rebuildLogLevel = getPlanRebuildLogLevel(reason, durationMs, outcome);
      if (rebuildLogLevel) {
        (host.deps.loggers?.structuredLog ?? logger)[rebuildLogLevel]({
          event: 'plan_rebuild_completed',
          durationMs,
          buildMs: outcome.buildMs,
          snapshotMs: outcome.snapshotMs,
          statusMs: outcome.statusMs,
          applyMs: outcome.applyMs,
          reasonCode: reason,
          actionChanged: outcome.actionChanged,
          detailChanged: outcome.detailChanged,
          metaChanged: outcome.metaChanged,
          hadShedding: outcome.hadShedding,
          appliedActions: outcome.appliedActions,
          deviceWriteCount: outcome.deviceWriteCount,
          commandRequestCount: outcome.commandRequestCount,
          failed: outcome.failed,
          ...buildPlanHeadroomLogFields(host.getLatestPlanSnapshot()),
          ...buildPlanCapacityStateSummary(host.getLatestPlanSnapshot(), {
            summarySource: 'plan_snapshot',
            summarySourceAtMs: host.getLatestPlanSnapshotUpdatedAtMs(),
          }),
        });
      }
    }
  };

  await withRebuildContext(rebuildId, run);
  return outcome;
}

async function executePlanRebuild(
  host: PlanRebuildHost,
  reason: string,
  isDryRun: boolean,
  outcome: PlanRebuildOutcome,
): Promise<void> {
  const { plan, buildMs } = await buildPlanForRebuild(host, reason);
  const nowMs = Date.now();
  const stampedPlan = host.stampPlanGeneratedAt(plan, nowMs);
  host.setLatestPlanSnapshot(stampedPlan);
  host.setLatestPlanSnapshotUpdatedAtMs(nowMs);
  const { changes, changeMs } = measurePlanChanges(host, stampedPlan);
  const { snapshotMs } = measureSnapshotUpdate(host, stampedPlan, changes);
  const { statusMs, statusWriteMs } = measureStatusUpdate(host, stampedPlan, changes);
  const hadShedding = hasShedding(stampedPlan);

  if (isDryRun && hadShedding) {
    (host.deps.loggers?.structuredLog ?? logger).info({
      event: 'shedding_dry_run_skipped',
      message: 'Dry run: shedding planned but not executed',
    });
  }

  const { applyMs, appliedActions, deviceWriteCount, commandRequestCount } = await maybeApplyPlanChanges(
    host,
    stampedPlan,
    changes,
    isDryRun,
  );
  if (changes.actionChanged || !host.getLatestReconcilePlanSnapshot()) {
    host.setLatestReconcilePlanSnapshot(host.getLatestPlanSnapshot() ?? stampedPlan);
  }
  Object.assign(outcome, {
    buildMs,
    changeMs,
    snapshotMs,
    statusMs,
    statusWriteMs,
    applyMs,
    actionChanged: changes.actionChanged,
    detailChanged: changes.detailChanged,
    metaChanged: changes.metaChanged,
    appliedActions,
    deviceWriteCount,
    commandRequestCount,
    hadShedding,
  });
}

async function buildPlanForRebuild(
  host: PlanRebuildHost,
  reason: string,
): Promise<{ plan: DevicePlan; buildMs: number }> {
  const { planEngine } = host.deps;
  const liveDevices = host.deps.getPlanDevices();
  planEngine.syncPendingTargetCommands(liveDevices, 'rebuild');
  planEngine.syncPendingBinaryCommands(host.settleDevices(), 'rebuild');
  const buildStart = Date.now();
  if (planEngine.state) {
    // Restore/target planning reads the active rebuild reason from shared plan state so
    // nested helpers do not need another plumbing parameter through the entire call stack.
    planEngine.state.currentRebuildReason = reason;
  }
  let plan: DevicePlan;
  try {
    plan = await planEngine.buildDevicePlanSnapshot(liveDevices);
  } finally {
    if (planEngine.state) {
      planEngine.state.currentRebuildReason = null;
    }
  }
  planEngine.prunePendingTargetCommands(plan);
  plan = planEngine.decoratePlanWithPendingTargetCommands(plan);
  return {
    plan,
    buildMs: Date.now() - buildStart,
  };
}

function measurePlanChanges(host: PlanRebuildHost, plan: DevicePlan): {
  changes: PlanChangeSet;
  changeMs: number;
} {
  const metaSignature = JSON.stringify(normalizePlanMeta(plan.meta));
  const changeStart = Date.now();
  const changes = host.trackChanges(plan, metaSignature);
  return {
    changes,
    changeMs: Date.now() - changeStart,
  };
}

function measureSnapshotUpdate(host: PlanRebuildHost, plan: DevicePlan, changes: PlanChangeSet): {
  snapshotMs: number;
} {
  const snapshotStart = Date.now();
  host.updatePlanSnapshot(plan, changes);
  return {
    snapshotMs: Date.now() - snapshotStart,
  };
}

function measureStatusUpdate(host: PlanRebuildHost, plan: DevicePlan, changes: PlanChangeSet): {
  statusMs: number;
  statusWriteMs: number;
} {
  const statusStart = Date.now();
  const statusWriteMs = host.updatePelsStatus(plan, changes);
  return {
    statusMs: Date.now() - statusStart,
    statusWriteMs,
  };
}

async function maybeApplyPlanChanges(
  host: PlanRebuildHost,
  plan: DevicePlan,
  changes: PlanChangeSet,
  isDryRun: boolean,
): Promise<{ applyMs: number; appliedActions: boolean; deviceWriteCount: number; commandRequestCount: number }> {
  const shouldApplyStablePlanActions = host.deps.planEngine.shouldApplyStablePlanActions(plan);
  if (isDryRun || (!changes.actionChanged && !shouldApplyStablePlanActions)) {
    return { applyMs: 0, appliedActions: false, deviceWriteCount: 0, commandRequestCount: 0 };
  }

  const applyStart = Date.now();
  let appliedActions = false;
  let deviceWriteCount = 0;
  let commandRequestCount = 0;
  try {
    const actuation = await host.deps.planEngine.applyPlanActions(plan, 'plan');
    const rawDeviceWriteCount = actuation?.deviceWriteCount;
    const rawCommandRequestCount = actuation?.commandRequestCount;
    deviceWriteCount = sanitizeActuationCount(rawDeviceWriteCount);
    commandRequestCount = sanitizeActuationCount(rawCommandRequestCount);
    appliedActions = deviceWriteCount > 0 || commandRequestCount > 0;
    if (appliedActions) {
      host.deps.schedulePostActuationRefresh?.();
    }
    const refreshed = refreshLatestPlanSnapshotFromSettledLiveState(host, plan);
    if (!refreshed) {
      refreshLatestPlanSnapshotPendingState(host);
    }
  } catch (error) {
    (host.deps.loggers?.structuredLog ?? logger).error({
      event: 'plan_actions_apply_failed',
      error: normalizeError(error),
    });
  }
  return {
    applyMs: Date.now() - applyStart,
    appliedActions,
    deviceWriteCount,
    commandRequestCount,
  };
}

function refreshLatestPlanSnapshotFromSettledLiveState(host: PlanRebuildHost, basePlan: DevicePlan): boolean {
  const livePlan = host.deps.planEngine.decoratePlanWithPendingTargetCommands(
    buildLiveStatePlan(basePlan, host.deps.getPlanDevices()),
  );
  if (!canRefreshPlanSnapshotFromLiveState(basePlan, livePlan)) return false;
  const refreshedPlan = host.preservePlanGeneratedAt(livePlan, basePlan);
  const nowMs = Date.now();
  host.setLatestPlanSnapshot(refreshedPlan);
  host.setLatestPlanSnapshotUpdatedAtMs(nowMs);
  host.setLatestReconcilePlanSnapshot(refreshedPlan);
  host.emitPlanUpdated(refreshedPlan);
  return true;
}

function refreshLatestPlanSnapshotPendingState(host: PlanRebuildHost): boolean {
  const current = host.getLatestPlanSnapshot();
  if (!current) return false;
  const nextPlan = host.deps.planEngine.decoratePlanWithPendingTargetCommands(current);
  if (buildPlanDetailSignature(nextPlan) === buildPlanDetailSignature(current)) {
    return false;
  }
  const refreshedPlan = host.preservePlanGeneratedAt(nextPlan, current);
  const nowMs = Date.now();
  host.setLatestPlanSnapshot(refreshedPlan);
  host.setLatestPlanSnapshotUpdatedAtMs(nowMs);
  host.emitPlanUpdated(refreshedPlan);
  return true;
}

function sanitizeActuationCount(value: unknown): number {
  return isFiniteNumber(value) ? Math.max(0, Math.trunc(value)) : 0;
}
