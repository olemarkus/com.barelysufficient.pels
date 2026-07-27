// The PUBLIC status of an active plan, and the revision-bus event that announces
// a change to it.
//
// Split out of `activePlanRecorder` because it answers a different question. The
// recorder owns what gets COMMITTED; this owns what gets REPORTED — the committed
// verdict with any live per-cycle overlay applied (today: the device is being
// left off outside PELS). The two diverge on purpose: freezing the overlay into
// a revision would keep it alive after the cause ended.

import { resolveEffectivePlanStatus } from '../../../packages/shared-domain/src/deadlineLabels';
import type {
  DeferredObjectiveActivePlanStatusV1,
  DeferredObjectiveActivePlanV1,
} from '../../../packages/contracts/src/deferredObjectiveActivePlans';
import type { ActivePlanPersistDeps } from './activePlanRevisionBuild';

/** This plan's public status, or `null` before it has a settled revision. */
export const effectivePlanStatusOf = (
  plan: DeferredObjectiveActivePlanV1,
): DeferredObjectiveActivePlanStatusV1 | null => {
  if (plan.latest === null) return null;
  return resolveEffectivePlanStatus(plan.latest.planStatus, plan.diagnosticReasonCode);
};

/**
 * Announce a status change caused purely by the LIVE overlay, so the public
 * "Smart task status changed" Flow trigger fires for it.
 *
 * The overlay deliberately writes no revision, and the revision bus is the only
 * thing that trigger listens to — without this the user watches the status flip
 * on every screen while their automation never runs.
 *
 * Call ONLY on a cycle that wrote no revision. A cycle that also settles
 * publishes a single event carrying the same pre-cycle effective status, so
 * Flows never see two transitions for one change — nor the momentary false
 * healthy transition between them.
 */
export const publishOverlayOnlyStatusChange = (
  deps: ActivePlanPersistDeps,
  plan: DeferredObjectiveActivePlanV1,
  previousEffective: DeferredObjectiveActivePlanStatusV1 | null,
): void => {
  const latest = plan.latest;
  if (latest === null || previousEffective === null) return;
  const after = effectivePlanStatusOf(plan);
  if (after === null || after === previousEffective) return;
  deps.onRevisionWritten?.({
    eventType: 'revision_written',
    deviceId: plan.deviceId,
    deviceName: plan.deviceName,
    objectiveKind: plan.objectiveKind,
    revision: latest,
    reason: latest.reason,
    previousPlanStatus: previousEffective,
    previousWasPending: false,
    allocationChanged: false,
    projectedFinishAtMs: null,
    effectivePlanStatus: after,
  });
};
