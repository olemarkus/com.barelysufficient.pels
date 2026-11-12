import { scheduleInstant } from '../../packages/shared-domain/src/scheduleTime';
import { getDateKeyInTimeZone, shiftDateKey } from '../../packages/shared-domain/src/utils/dateUtils';
import type { Schedule } from '../../packages/contracts/src/schedules';
import type { SmartTaskCandidateDevice } from '../../packages/contracts/src/smartTaskEdit';
import type { SmartTaskHomeScope } from '../../packages/contracts/src/smartTaskHomeScope';
import {
  normalizeDeferredObjectiveSettingsEntry,
} from '../../packages/shared-domain/src/settings/deferredObjectiveSettings';
import { ScheduleSkip } from './scheduleSkip';
import { rejectForSmartTaskHomeScope } from '../objectives/deferredObjectives/smartTaskCreateLane';
import {
  buildSmartTaskCandidateBase,
  resolveSmartTaskWriteDeadline,
} from '../objectives/deferredObjectives/smartTaskCandidateRequest';
import {
  setSmartTaskDeadline,
  setSmartTaskRescuePermission,
  type SmartTaskCommandPort,
} from '../objectives/deferredObjectives/smartTaskCommands';
import type { ObjectiveWriteOutcome } from '../objectives/deferredObjectives/objectiveWrite';

const requireTaskWrite = (outcome: ObjectiveWriteOutcome): void => {
  if (outcome.persisted) return;
  const { reason } = outcome;
  switch (reason) {
    case 'device_not_planned': throw new Error('PELS does not manage this device.');
    case 'device_in_sub_home': throw new Error('This device is in a separately metered home.');
    case 'untrusted_absence':
    case 'ownership_unavailable': throw new Error('The Smart task could not be saved.');
    default: {
      const exhaustive: never = reason;
      throw new Error(`Unexpected task write refusal: ${exhaustive}`);
    }
  }
};

/** Commands shared with manual/Flow actions; this executor owns no device writes. */
type ScheduleActionHost = SmartTaskCommandPort & {
  resolveSmartTaskHomeScope(deviceId: string): SmartTaskHomeScope;
  listTaskDevices(): SmartTaskCandidateDevice[];
  handleOperatingModeChange(mode: string): Promise<void>;
};

export class ScheduleActionExecutor {
  constructor(private readonly host: ScheduleActionHost, private readonly clock: { getTimezone(): string }) {}

  async execute(schedule: Schedule, scheduledAtMs: number): Promise<void> {
    if (schedule.action.type === 'mode') {
      await this.host.handleOperatingModeChange(schedule.action.mode);
      return;
    }
    const request = schedule.action.task;
    const scope = rejectForSmartTaskHomeScope(this.host.resolveSmartTaskHomeScope(request.deviceId));
    if (scope === 'unavailable') throw new Error('The device is temporarily unavailable.');
    if (scope) throw new ScheduleSkip('Skipped because this device is not available for a scheduled Smart task.');
    // Resolve against the occurrence, not a late timer: a passed deadline never rolls a run into tomorrow.
    const timeZone = this.clock.getTimezone();
    const date = getDateKeyInTimeZone(new Date(scheduledAtMs), timeZone);
    const readyDate = request.readyByLocalTime <= schedule.at ? shiftDateKey(date, 1) : date;
    const deadlineAtMs = scheduleInstant(readyDate, request.readyByLocalTime, timeZone);
    if (deadlineAtMs === undefined) {
      throw new ScheduleSkip('Skipped because the ready-by time does not exist on this date.');
    }
    const deadline = resolveSmartTaskWriteDeadline({ ...request, deadlineAtMs }, timeZone, Date.now());
    if (!deadline.ok) throw new ScheduleSkip('Skipped because the ready-by time had already passed.');
    const entry = normalizeDeferredObjectiveSettingsEntry({
      ...buildSmartTaskCandidateBase(request.kind, request.target, deadline.deadlineAtMs),
      enabled: true,
      scheduleSource: { id: schedule.id, name: schedule.name },
    });
    if (!entry) throw new Error('The task target is invalid.');
    const device = this.host.listTaskDevices().find((candidate) => candidate.deviceId === request.deviceId);
    if (!device) throw new Error('The device was not found.');
    requireTaskWrite(setSmartTaskDeadline(this.host, request.deviceId, device.deviceName, entry));
    // An unchecked permission means its Flow card did not run, so keep its standing mode.
    for (const permission of ['exemptFromBudget', 'limitLowerPriorityDevices', 'pauseLowerPriorityDevices'] as const) {
      if (request[permission]) {
        const outcome = setSmartTaskRescuePermission(this.host, request.deviceId, permission, 'always');
        if (!outcome.persisted) {
          throw new Error('The Smart task was saved, but an extra permission could not be saved.');
        }
      }
    }
  }
}
