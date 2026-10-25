import {
  createEmptyDeferredObjectiveRoster,
  normalizeDeferredObjectiveSettingsEntry,
} from '../../../shared-domain/src/settings/deferredObjectiveSettings.ts';
import type { DeferredObjectiveRoster } from '../../../contracts/src/deferredObjectiveSettings.ts';
import { isUnknownRecord } from '../../../shared-domain/src/recordGuards.ts';

// Parse the smart-task roster the runtime serves (the bootstrap's
// `deferredObjectives`, `/ui_deferred_objective_settings`): a malformed
// payload reads as no tasks, and a malformed entry is dropped.
export const normalizeDeferredObjectiveRoster = (raw: unknown): DeferredObjectiveRoster => {
  if (!isUnknownRecord(raw)) return createEmptyDeferredObjectiveRoster();
  const entries = raw.objectivesByDeviceId;
  if (!isUnknownRecord(entries)) return createEmptyDeferredObjectiveRoster();

  return {
    objectivesByDeviceId: Object.fromEntries(
      Object.entries(entries).flatMap(([deviceId, entry]) => {
        const normalizedDeviceId = deviceId.trim();
        const normalized = normalizeDeferredObjectiveSettingsEntry(entry);
        return normalizedDeviceId && normalized ? [[normalizedDeviceId, normalized]] : [];
      }),
    ),
  };
};
