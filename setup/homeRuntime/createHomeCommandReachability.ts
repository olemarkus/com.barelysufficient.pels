/**
 * One home's binary-command reachability lane. It learns that a device PELS
 * thought it could command has become uncommandable (or the reverse), which is
 * a change to what the planner may DO and so a rebuild trigger in its own
 * right — not an observation of what a device is doing.
 *
 * Every home wires the same timers on the same key shape and differs only in
 * how it reaches its own plan service, so `rebuild` is the whole difference:
 * the main home throws if its service is missing, a meter area drops the
 * rebuild once torn down.
 */
import type { AppContext } from '../../lib/app/appContext';
import {
  createBinaryCommandReachability,
  type BinaryCommandReachability,
} from '../../lib/plan/admission/binaryCommandReachability';
import type { PlanRebuildTrigger } from '../../lib/plan/planRebuildTrigger';
import type { HomeId } from '../../lib/utils/settingsKeys';

export function createHomeCommandReachability(
  ctx: AppContext,
  homeId: HomeId,
  rebuild: (trigger: PlanRebuildTrigger) => void,
): BinaryCommandReachability {
  const timerKey = (deviceId: string) => `binaryCommandReachability:${homeId}:${deviceId}`;
  return createBinaryCommandReachability({
    // Off the current turn: the lane is driven from an observation, and the
    // rebuild must not re-enter the caller that is still recording it.
    requestRebuild: () => {
      queueMicrotask(() => rebuild('binary_command_reachability_changed'));
    },
    scheduleRebuild: (deviceId, dueAtMs) => {
      const key = timerKey(deviceId);
      ctx.timers.registerTimeout(key, setTimeout(() => {
        ctx.timers.clear(key);
        rebuild('binary_command_reachability_deadline');
      }, Math.max(0, dueAtMs - Date.now())));
    },
    clearScheduledRebuild: (deviceId) => {
      ctx.timers.clear(timerKey(deviceId));
    },
  });
}
