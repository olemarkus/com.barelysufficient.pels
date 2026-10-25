import { readAllObjectives } from '../../lib/objectives/deferredObjectives/objectiveStore';
import { PER_DEVICE_OBJECTIVE_KEY_PREFIX } from '../../lib/utils/settingsKeys';
import type { DeferredObjectiveRoster } from '../../packages/contracts/src/deferredObjectiveSettings';

/**
 * The roster the runtime hands its consumers for these stored tasks: each one
 * under its own `deferred_objective.<deviceId>` key, read back through
 * `readAllObjectives`, so a malformed entry drops out exactly as it does in
 * production.
 */
export const objectiveRosterFor = (
  stored: { objectivesByDeviceId: Record<string, unknown> },
): DeferredObjectiveRoster => {
  const keys = new Map(Object.entries(stored.objectivesByDeviceId)
    .map(([deviceId, entry]) => [`${PER_DEVICE_OBJECTIVE_KEY_PREFIX}${deviceId}`, entry]));
  return readAllObjectives({
    get: (key) => keys.get(key),
    set: () => { throw new Error('objectiveRosterFor is read-only'); },
    unset: () => { throw new Error('objectiveRosterFor is read-only'); },
    getKeys: () => [...keys.keys()],
  });
};
