import type {
  DeferredObjectiveRescueMode,
  DeferredObjectiveRescuePermissions,
  DeferredObjectiveRoster,
  DeferredObjectiveSettingsEntry,
} from '../../../packages/contracts/src/deferredObjectiveSettings';
import type { ObjectiveWriteOutcome } from './objectiveWrite';

/** The task store and device-scoped write shared by Flow and scheduled commands. */
export type SmartTaskCommandPort = {
  getDeferredObjectiveSettings(): DeferredObjectiveRoster;
  upsertDeferredObjectiveForDevice(
    deviceId: string,
    deviceName: string | null,
    entry: DeferredObjectiveSettingsEntry,
    rescue?: 'preserve' | 'replace',
  ): ObjectiveWriteOutcome;
};

export type SmartTaskPermissionWriteOutcome = ObjectiveWriteOutcome
  | { persisted: false; reason: 'no_task' };

/** A deadline command replaces the goal and keeps the task's standing permissions. */
export const setSmartTaskDeadline = (
  port: SmartTaskCommandPort,
  deviceId: string,
  deviceName: string | null,
  entry: DeferredObjectiveSettingsEntry,
): ObjectiveWriteOutcome => port.upsertDeferredObjectiveForDevice(deviceId, deviceName, entry);

// This command owns one permission; the other permissions keep their standing modes.
const withRescuePermission = (
  entry: DeferredObjectiveSettingsEntry,
  key: keyof DeferredObjectiveRescuePermissions,
  mode: DeferredObjectiveRescueMode | undefined,
): DeferredObjectiveSettingsEntry => {
  const exemptFromBudget = key === 'exemptFromBudget' ? mode : entry.rescue?.exemptFromBudget;
  const limitLowerPriorityDevices = key === 'limitLowerPriorityDevices'
    ? mode : entry.rescue?.limitLowerPriorityDevices;
  const pauseLowerPriorityDevices = key === 'pauseLowerPriorityDevices'
    ? mode : entry.rescue?.pauseLowerPriorityDevices;
  const rescue: DeferredObjectiveRescuePermissions | undefined = (
    exemptFromBudget || limitLowerPriorityDevices || pauseLowerPriorityDevices
  ) ? {
      ...(exemptFromBudget ? { exemptFromBudget } : {}),
      ...(limitLowerPriorityDevices ? { limitLowerPriorityDevices } : {}),
      ...(pauseLowerPriorityDevices ? { pauseLowerPriorityDevices } : {}),
    } : undefined;
  return { ...entry, rescue };
};

/** Set or clear one standing permission, without writing when its mode is unchanged. */
export const setSmartTaskRescuePermission = (
  port: SmartTaskCommandPort,
  deviceId: string,
  key: keyof DeferredObjectiveRescuePermissions,
  mode: DeferredObjectiveRescueMode | undefined,
): SmartTaskPermissionWriteOutcome => {
  const entry = port.getDeferredObjectiveSettings().objectivesByDeviceId[deviceId];
  if (!entry) return { persisted: false, reason: 'no_task' };
  if (entry.rescue?.[key] === mode) return { persisted: true };
  return port.upsertDeferredObjectiveForDevice(deviceId, null, withRescuePermission(entry, key, mode), 'replace');
};
