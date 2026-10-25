import type { AppContext } from '../../lib/app/appContext';
import type { CancelDeferredObjectiveOutcome } from '../../lib/app/pelsHost';
import { clearObjectiveForDevice } from '../../lib/objectives/deferredObjectives';
import { objectiveAbsenceIsTrustworthy } from '../../lib/objectives/deferredObjectives/objectiveStore';
import { buildDeferredObjectiveDeviceWriteDeps } from './deferredRecorders';

/**
 * Settings-UI clear of a device's smart task — the same device-scoped clear op
 * the `clear_deadline` Flow card runs, including its forget side effects.
 * `task_not_found` is answered ONLY on a TRUSTWORTHY absence (key list readable
 * AND the key missing). A present key or a transient-empty `getKeys()` flake
 * falls through to the idempotent unset in `clearObjectiveForDevice`, so one
 * flaky read never makes the UI report a still-running task as "already ended"
 * (`feedback_homey_sdk_unreliable`).
 */
export const cancelDeferredObjectiveForContext = (
  ctx: AppContext,
  deviceId: string,
): CancelDeferredObjectiveOutcome => {
  if (objectiveAbsenceIsTrustworthy(ctx.homey.settings, deviceId)) {
    return { ok: false, reason: 'task_not_found' };
  }
  const deviceName = ctx.deviceConfiguration.get(deviceId)?.name ?? null;
  clearObjectiveForDevice(
    buildDeferredObjectiveDeviceWriteDeps(ctx, ctx.getNow().getTime()),
    { deviceId, deviceName },
  );
  ctx.deferredObjectiveStatusBus.forgetDevice(deviceId);
  ctx.deferredObjectiveHoursRemainingTracker.forgetDevice(deviceId);
  return { ok: true };
};
