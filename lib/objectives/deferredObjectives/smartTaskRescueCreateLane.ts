import type {
  DeferredObjectivePlanPreviewCandidate,
} from '../../../packages/contracts/src/deferredObjectivePlanPreview';
import type { WidgetObjectiveWriteResult } from '../../../packages/contracts/src/widgetHostApi';
import { hasOpenDeferredObjective } from './objectiveStore';
import { upsertSmartTask, type SmartTaskWritePorts } from './smartTaskWrite';
import type { SmartTaskWriteDevice } from './smartTaskWriteValidation';

// The rescue-create lane: the starvation_rescue widget's and the overview
// device card's "Let it run now". Both surfaces resolve the rescuable row and
// build the candidate (`packages/shared-domain/src/starvationRescueShared.ts`),
// then reach this through the app's `rescueDeviceWithBudgetExemption`.
// `setup/` binds the ports and forwards.
//
// A rescue is always a FRESH task: the starved list only offers a device with
// no smart task, and this lane re-asserts it, so the rescue reuses the create
// write with no merge. The candidate carries all three extra permissions;
// `validateSmartTaskWrite`'s permission gate keeps the budget exemption and the
// startup reservation for any device and the limit-lower-priority grant where
// it has effect, so the surfaces read what was granted from the preview.
//
// A rescue lifts the daily budget and redistributes load within the capacity
// cap; it never raises the cap.

/**
 * Create a budget-exempt rescue task. Refuses a candidate without the budget
 * exemption, so the exemption cannot be smuggled through a generic create, and
 * a device with an open task, so a rescue never replaces the user's own active
 * or paused task.
 */
export const createRescueSmartTask = <Device extends SmartTaskWriteDevice>(
  ports: SmartTaskWritePorts<Device>,
  deviceId: string,
  candidate: DeferredObjectivePlanPreviewCandidate,
): WidgetObjectiveWriteResult => {
  // The exemption persists even while no daily budget is on: it is one of the
  // conditions under which the planner fully reserves the rescue's steps
  // (`rescueReplan.ts`), so dropping it would plan a stepped device at its
  // lowest step.
  if (candidate.rescue?.exemptFromBudget !== 'always') {
    return { ok: false, reason: 'invalid_candidate' };
  }
  if (hasOpenDeferredObjective(ports.reads.store, deviceId, ports.nowMs)) {
    return { ok: false, reason: 'device_not_eligible' };
  }
  // `'preserve'`: with no open task there is no standing rescue to preserve or
  // replace, so this takes the additive default the widget create uses.
  return upsertSmartTask(ports, deviceId, candidate, 'preserve');
};
