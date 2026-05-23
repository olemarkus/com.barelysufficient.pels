import type { PlanInputDevice } from '../planTypes';
import type { DeferredObjectiveSettingsV1 } from './settings';

// Counts the priority-1 fully-reserved smart tasks present this cycle so the
// per-task `policyHorizon` producer can split each bucket's reserved headroom
// equally instead of every eligible task promoting to the full forecast (which
// double-books the reserved slot in diagnostic verdicts).
//
// Eligibility mirrors `fullyReserved` in `rescueReplan.ts` (the only path that
// actually consumes `reservedHeadroomKw`): enabled, has device, device is
// strictly top-priority, both rescue permissions are `'always'`. Stable across
// plan cycles for stable settings + device priorities — the only input that
// flickers in practice is `device.priority`, which is configured, not measured.
// See the equal-share rationale in `policyHorizon.resolveReservedHeadroomKw`.
export const countConcurrentEligibleTasks = (params: {
  settings: DeferredObjectiveSettingsV1;
  deviceById: Map<string, PlanInputDevice>;
}): number => {
  let count = 0;
  for (const [deviceId, objective] of Object.entries(params.settings.objectivesByDeviceId)) {
    if (!objective.enabled) continue;
    if (objective.rescue?.exemptFromBudget !== 'always') continue;
    if (objective.rescue?.limitLowerPriorityDevices !== 'always') continue;
    const device = params.deviceById.get(deviceId);
    if (!device) continue;
    if (device.priority !== 1) continue;
    count += 1;
  }
  return count;
};
