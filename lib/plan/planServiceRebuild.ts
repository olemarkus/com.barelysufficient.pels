/**
 * Rebuild orchestration for `PlanService`. Extracted (slice: full builder
 * pipeline run) so the service file stays under the line ceiling while keeping
 * sync sequencing alongside the public surface. These functions own the
 * WHEN-to-actuate sequencing of a single rebuild: build → stamp → track
 * changes → snapshot/status update → conditional apply → pending-target
 * decoration republish → completion metrics/log. They mutate `PlanService` state only through
 * the `PlanRebuildHost` seam so the service keeps its private fields. Behaviour
 * is identical to the former `PlanService.performPlanRebuild` and its private
 * helpers; the intent-queue serialization stays in `PlanService`.
 */
import { randomUUID } from 'node:crypto';
import type { SteppedSettleDevice } from '../observer/steppedSettleSnapshot';
import { incPerfCounter } from '../utils/perfCounters';
import { recordOpRssDelta, safeRss } from '../utils/opRssTracker';
import { startRuntimeSpan } from '../utils/runtimeTrace';
import { normalizeError } from '../utils/errorUtils';
import { getLogger, withRebuildContext } from '../logging/logger';
import { buildPlanDetailSignature, buildPublishedPlanCapacityStateSummary } from './planLogging';
import type { PublishedPlan } from './publishedPlan';
import { hasShedding } from './planServiceInternals';
import {
  buildPlanHeadroomLogFields,
  createPlanRebuildOutcome,
  getPlanRebuildLogLevel,
  recordPlanRebuildMetrics,
} from './planRebuildMetrics';
import { normalizePlanMeta } from './planStatusHelpers';
import { describePlanRebuildTrigger, type PlanRebuildTrigger } from './planRebuildTrigger';
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
  getLatestPublishedPlan: () => PublishedPlan | null;
  /** Publishes a plan and its time together (`PublishedPlan`). */
  publishPlan: (plan: DevicePlan, publishedAtMs: number) => void;
  settleDevices: () => PendingBinaryLiveDevice[];
  steppedSettleDevices: () => readonly SteppedSettleDevice[];
  trackChanges: (plan: DevicePlan, metaSignature: string) => PlanChangeSet;
  updatePlanSnapshot: (plan: DevicePlan, changes: PlanChangeSet) => void;
  updatePelsStatus: (plan: DevicePlan, changes?: StatusPlanChanges) => number;
  stampPlanGeneratedAt: (plan: DevicePlan, nowMs?: number) => DevicePlan;
  preservePlanGeneratedAt: (plan: DevicePlan, basePlan: DevicePlan) => DevicePlan;
  emitPlanUpdated: (plan: DevicePlan) => void;
};

export async function performPlanRebuild(
  host: PlanRebuildHost,
  params: {
    trigger: PlanRebuildTrigger;
    detail?: string;
    queueWaitMs: number;
    queueDepth: number;
  },
): Promise<PlanRebuildOutcome> {
  const { trigger, detail, queueWaitMs, queueDepth } = params;
  // The composed label is for humans reading logs. Everything that DECIDES
  // anything keeps the closed `trigger` value.
  const reason = describePlanRebuildTrigger(trigger, detail);
  const isDryRun = host.deps.getCapacityDryRun();
  const rebuildId = `rb_${randomUUID()}`;
  const rebuildStart = Date.now();
  const rssBefore = safeRss();
  const stopSpan = startRuntimeSpan(`plan_rebuild(${reason})`);
  const outcome = createPlanRebuildOutcome(isDryRun);

  /* eslint-disable functional/immutable-data -- In-place update avoids another state or accumulator copy. */
  const run = async (): Promise<void> => {
    try {
      await executePlanRebuild(host, trigger, isDryRun, outcome);
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
      const rebuildLogLevel = getPlanRebuildLogLevel(trigger, durationMs, outcome);
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
          ...buildPublishedPlanCapacityStateSummary(host.getLatestPublishedPlan()),
        });
      }
    }
  };
  /* eslint-enable functional/immutable-data */

  await withRebuildContext(rebuildId, run);
  return outcome;
}

/* eslint-disable functional/immutable-data -- In-place update avoids another state or accumulator copy. */
async function executePlanRebuild(
  host: PlanRebuildHost,
  trigger: PlanRebuildTrigger,
  isDryRun: boolean,
  outcome: PlanRebuildOutcome,
): Promise<void> {
  const { plan, buildMs, observationRevision } = await buildPlanForRebuild(host, trigger);
  const nowMs = Date.now();
  const stampedPlan = host.stampPlanGeneratedAt(plan, nowMs);
  host.publishPlan(stampedPlan, nowMs);
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

  const {
    applyMs, appliedActions, deviceWriteCount, commandRequestCount, deviceApplyFailureCount, writtenDeviceIds,
  } = await maybeApplyPlanChanges(
    host,
    stampedPlan,
    changes,
    isDryRun,
    observationRevision,
  );
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
    deviceApplyFailureCount,
    writtenDeviceIds,
    hadShedding,
  });
}
/* eslint-enable functional/immutable-data */

/* eslint-disable functional/immutable-data -- In-place update avoids another state or accumulator copy. */
async function buildPlanForRebuild(
  host: PlanRebuildHost,
  trigger: PlanRebuildTrigger,
): Promise<{ plan: DevicePlan; buildMs: number; observationRevision: number }> {
  const { planEngine } = host.deps;
  planEngine.syncPendingBinaryCommands(host.settleDevices(), 'rebuild');
  planEngine.syncSteppedCommands(() => host.steppedSettleDevices());
  // Read BEFORE the inputs are captured. The build below awaits, so a realtime
  // observation can land mid-build; this is what lets the apply step tell that
  // the plan was decided against a world that has since moved.
  const observationRevision = planEngine.getObservationRevision();
  const liveDevices = host.deps.getPlanDevices();
  planEngine.syncPendingTargetCommands(liveDevices, 'rebuild');
  const buildStart = Date.now();
  // Restore/target planning reads the active rebuild trigger from shared plan state so
  // nested helpers do not need another plumbing parameter through the entire call stack.
  planEngine.state.currentRebuildTrigger = trigger;
  let plan: DevicePlan;
  try {
    plan = await planEngine.buildDevicePlanSnapshot(liveDevices);
  } finally {
    planEngine.state.currentRebuildTrigger = null;
  }
  planEngine.prunePendingTargetCommands(plan);
  plan = planEngine.decoratePlanWithPendingTargetCommands(plan);
  return {
    plan,
    buildMs: Date.now() - buildStart,
    observationRevision,
  };
}
/* eslint-enable functional/immutable-data */

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

/**
 * Actuate when the plan's actions changed, OR when the executor still has work
 * to do against the plan we just built.
 *
 * The second clause is what lets a rebuild correct a device that has drifted
 * away from decisions the rebuild did not itself change. Without it, an
 * unchanged action signature short-circuits the apply, and the only thing left
 * that could correct the device is the reconcile lane — which re-asserts a plan
 * nobody re-decided against the new observation. That is how PELS breached its
 * own hard cap (inc_26449fb9): the reconcile beat the planner to the
 * device by 281 ms and re-asserted a step-up its own admission gate would have
 * rejected.
 *
 * The verdict is qualified by the observation revision the plan was BUILT from.
 * The build awaits, so a realtime observation can land mid-build; acting on a
 * device change this plan never incorporated would apply a decision nobody made
 * against it — the `inc_26449fb9` shape under a new name. When the observer has
 * moved, this cycle declines and the next whole-home reading re-decides.
 *
 * The planner hands over NO live side any more. It used to pass the same
 * `PlanInputDevice[]` the plan was built from, on the reasoning that a re-read
 * would compare intent against observations the planner never saw. That
 * reasoning protected the wrong thing: the risk it named is re-asserting a
 * DECISION nobody re-made, and the plan being applied here is the one just
 * built. Meanwhile it forced the executor's live side to be a plan-layer shape,
 * which is what gave `observedBinaryState` two meanings — one of the
 * drift/reconcile layering inversions. The executor now reads the observation
 * from the observer and the in-flight command state from its own stores, so
 * this asks "does the device disagree with what we decided?" against the
 * freshest answer available — and an observation that landed since the build is
 * a reason to act, not one to discard.
 *
 * `shouldApplyStablePlanActions` stays alongside it rather than being subsumed:
 * it covers cases the intent-drift predicate deliberately excludes — an
 * uncontrolled device's restore (drift derives an expected `on` only when the
 * binary intent is `controlled`), and the stepped command-hold / transition-phase
 * conditions that a bare observed-vs-desired step comparison cannot express.
 */
function shouldApplyPlan(
  host: PlanRebuildHost,
  plan: DevicePlan,
  changes: PlanChangeSet,
  isDryRun: boolean,
  observationRevision: number,
): boolean {
  if (isDryRun) return false;
  if (changes.actionChanged) return true;
  if (host.deps.planEngine.shouldApplyStablePlanActions(plan)) return true;
  return host.deps.planEngine.hasExecutionWorkOutstanding(plan, observationRevision);
}

async function maybeApplyPlanChanges(
  host: PlanRebuildHost,
  plan: DevicePlan,
  changes: PlanChangeSet,
  isDryRun: boolean,
  observationRevision: number,
): Promise<{
  applyMs: number;
  appliedActions: boolean;
  deviceWriteCount: number;
  commandRequestCount: number;
  deviceApplyFailureCount: number;
  writtenDeviceIds: string[];
}> {
  if (!shouldApplyPlan(host, plan, changes, isDryRun, observationRevision)) {
    return {
      applyMs: 0,
      appliedActions: false,
      deviceWriteCount: 0,
      commandRequestCount: 0,
      deviceApplyFailureCount: 0,
      writtenDeviceIds: [],
    };
  }

  const applyStart = Date.now();
  let appliedActions = false;
  let deviceWriteCount = 0;
  let commandRequestCount = 0;
  let deviceApplyFailureCount = 0;
  let writtenDeviceIds: string[] = [];
  try {
    const actuation = await host.deps.planEngine.applyPlanActions(plan);
    ({ deviceWriteCount, commandRequestCount, deviceApplyFailureCount, writtenDeviceIds } = actuation);
    appliedActions = deviceWriteCount > 0 || commandRequestCount > 0;
    if (appliedActions) {
      host.deps.schedulePostActuationRefresh?.();
    }
    refreshLatestPlanSnapshotPendingState(host);
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
    deviceApplyFailureCount,
    writtenDeviceIds,
  };
}

function refreshLatestPlanSnapshotPendingState(host: PlanRebuildHost): void {
  const current = host.getLatestPlanSnapshot();
  if (!current) return;
  const nextPlan = host.deps.planEngine.decoratePlanWithPendingTargetCommands(current);
  if (buildPlanDetailSignature(nextPlan) === buildPlanDetailSignature(current)) return;
  const refreshedPlan = host.preservePlanGeneratedAt(nextPlan, current);
  const nowMs = Date.now();
  host.publishPlan(refreshedPlan, nowMs);
  host.emitPlanUpdated(refreshedPlan);
}

