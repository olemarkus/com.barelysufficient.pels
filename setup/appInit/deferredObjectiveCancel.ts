import type { AppContext } from '../../lib/app/appContext';
import { clearObjectiveForDevice, migrateBlobToPerKeyIfNeeded } from '../../lib/objectives/deferredObjectives';
import { objectiveAbsenceIsTrustworthy } from '../../lib/objectives/deferredObjectives/objectiveStore';
import { buildDeferredObjectiveDeviceWriteDeps } from './deferredRecorders';

export type CancelDeferredObjectiveOutcome = { ok: true } | {
  ok: false;
  reason: 'task_not_found' | 'write_refused';
};

/**
 * Settings-UI clear of a device's smart task — the same device-scoped clear op
 * the `clear_deadline` Flow card runs, including its forget side effects. Two
 * contracts hold:
 *
 * - `task_not_found` is answered ONLY on a TRUSTWORTHY absence (key list
 *   readable AND the key missing). A present key or a transient-empty
 *   `getKeys()` flake falls through to `clearObjectiveForDevice`, which
 *   self-guards (idempotent unset; un-confirmable migration → retryable
 *   `write_refused`) — one flaky read must never make the UI report a
 *   still-running task as "already ended" (`feedback_homey_sdk_unreliable`).
 * - The live status-bus / hours-tracker memory is forgotten only AFTER a
 *   confirmed persist, mirroring the Flow card's ordering, so a refused clear
 *   never desyncs lifecycle surfaces from a task that is still stored.
 */
export const cancelDeferredObjectiveForContext = (
  ctx: AppContext,
  deviceId: string,
): CancelDeferredObjectiveOutcome => {
  const settings = ctx.homey.settings;
  // Same migrate-first guard as the other objective-write lanes: a task still
  // only in the legacy blob is invisible to the per-key existence check.
  migrateBlobToPerKeyIfNeeded(settings);
  if (objectiveAbsenceIsTrustworthy(settings, deviceId)) {
    return { ok: false, reason: 'task_not_found' };
  }
  const deviceName = ctx.latestTargetSnapshot.find((entry) => entry.id === deviceId)?.name ?? null;
  const outcome = clearObjectiveForDevice(
    buildDeferredObjectiveDeviceWriteDeps(ctx, {
      nowMs: ctx.getNow().getTime(),
      rebuildReason: 'settings_ui:smart_task_cancel',
    }),
    { deviceId, deviceName },
  );
  if (!outcome.persisted) return { ok: false, reason: 'write_refused' };
  ctx.deferredObjectiveStatusBus.forgetDevice(deviceId);
  ctx.deferredObjectiveHoursRemainingTracker.forgetDevice(deviceId);
  return { ok: true };
};
