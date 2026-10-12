import { state } from './state.ts';

// Which devices have used Smart tasks: one stored now, or one seen in task
// history. Positive evidence survives a task being cleared or the history read
// becoming unavailable, so a device keeps its Smart task settings ("Only PELS
// starts this device") between tasks. The setup suggestion "Keep {device}
// within Smart tasks" and the device page read the same evidence, so the
// suggestion never sends the owner to a row the page hides.
const seenDeviceIds = new Set<string>();

const noteStoredTasks = (): void => {
  for (const deviceId of Object.keys(state.deferredObjectiveSettings.objectivesByDeviceId)) {
    seenDeviceIds.add(deviceId);
  }
};

/** Record the devices task history shows a run for. */
export const recordSmartTaskHistoryDevices = (deviceIds: Iterable<string>): void => {
  for (const deviceId of deviceIds) seenDeviceIds.add(deviceId);
};

export const hasUsedSmartTasks = (deviceId: string): boolean => {
  noteStoredTasks();
  return seenDeviceIds.has(deviceId);
};

export const readSmartTaskUsageDeviceIds = (): ReadonlySet<string> => {
  noteStoredTasks();
  return seenDeviceIds;
};
