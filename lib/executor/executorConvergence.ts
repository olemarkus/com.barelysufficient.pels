/**
 * Convergence predicate: does observed device state still disagree with the
 * plan's intent?
 *
 * Owned by the executor because converging observed onto desired is this
 * layer's charter — the planner decides desired state from its own inputs and
 * knows nothing about drift (`lib/plan/AGENTS.md`, `lib/AGENTS.md` § Layer
 * boundaries). It makes no planning decision and never mutates a plan.
 *
 * `hasPlanExecutionDriftAgainstIntent` compares live observations against
 * planner INTENT, per device, via `hasPlanDeviceExecutionDrift`. It answers
 * "does the executor have work to do?", and an actuation decision may consult
 * it only against the plan the rebuild just built.
 *
 * There used to be a plan-to-plan SETTLE question beside it, which compared
 * the published plan with a copy that had the current device inputs merged in
 * and, once every dispatched actuation had landed, adopted the copy as the
 * published plan. It is gone with the merge: the copy carried the raw input's
 * posture beside the plan's decisions, and every reader of the published plan
 * already takes its observations from the observer and the executor.
 *
 * Governing reference: `notes/state-management/README.md`.
 */
import type { DevicePlan } from '../plan/planTypes';
import type { DriftObservationDeps } from './driftObservedDevice';
import { hasPlanDeviceExecutionDrift } from './planExecutionDrift';
import { hasStorageDecision } from '../planContract/storageDecision';

/**
 * Does the executor have work to do against this plan?
 *
 * Takes READERS, not a device list. The observation is pulled per device from
 * the observer and the in-flight command state from this layer's own stores, so
 * nothing the planner produced reaches the live side of the comparison. A
 * device with no observation yet is skipped rather than assumed: absence is not
 * evidence of agreement, and inventing a reading here would hand control a
 * value more favourable than anything measured.
 */
export function hasPlanExecutionDriftAgainstIntent(
  plan: DevicePlan,
  deps: DriftObservationDeps,
): boolean {
  if (plan.storageReleases.some((intent) => deps.hasStorageReleaseDrift(intent))) return true;
  for (const planDevice of plan.devices) {
    if (hasStorageDecision(planDevice) && deps.hasStorageDrift(planDevice)) return true;
    const observed = deps.getObservedState(planDevice.id);
    if (!observed) continue;
    if (hasPlanDeviceExecutionDrift({
      planDevice,
      observed,
      command: deps.getCommandState(planDevice.id),
      externalOffHeld: deps.isExternalOffHeld(planDevice.id),
    })) return true;
  }
  return false;
}
