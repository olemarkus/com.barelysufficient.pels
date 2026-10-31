import { scheduleInstant } from '../../packages/shared-domain/src/scheduleTime';
import { getDateKeyInTimeZone, shiftDateKey } from '../../packages/shared-domain/src/utils/dateUtils';
import type { Schedule } from '../../packages/contracts/src/schedules';
import type { NewSmartTaskWriteResult } from '../../packages/contracts/src/smartTaskEdit';
import { ScheduleSkip } from './scheduleSkip';
import type { SmartTaskCreateLaneHost } from '../objectives/deferredObjectives/smartTaskCreateLane';
import { rejectForSmartTaskHomeScope } from '../objectives/deferredObjectives/smartTaskCreateLane';
import {
  buildValidSmartTaskCandidate,
  resolveSmartTaskWriteDeadline,
} from '../objectives/deferredObjectives/smartTaskCandidateRequest';

type CreateFailure = Exclude<NewSmartTaskWriteResult, { ok: true } | { reason: 'task_exists' }>['reason'];
const CREATE_FAILURES: Record<CreateFailure, string> = {
  device_not_found: 'The device was not found.',
  device_not_planned: 'PELS does not manage this device.',
  device_not_eligible: 'This device cannot take this Smart task now.',
  device_in_sub_home: 'This device is in a separately metered home.',
  invalid_candidate: 'The task target is invalid.',
  write_refused: 'The Smart task could not be saved.',
};

/** Commands shared with manual/Flow actions; this executor owns no device writes. */
type ScheduleActionHost = SmartTaskCreateLaneHost & {
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
    if (scope) throw new ScheduleSkip('Skipped: this device is not available for a scheduled Smart task.');
    // Resolve against the occurrence, not a late timer: a passed deadline never rolls a run into tomorrow.
    const timeZone = this.clock.getTimezone();
    const date = getDateKeyInTimeZone(new Date(scheduledAtMs), timeZone);
    const readyDate = request.readyByLocalTime <= schedule.at ? shiftDateKey(date, 1) : date;
    const deadlineAtMs = scheduleInstant(readyDate, request.readyByLocalTime, timeZone);
    if (deadlineAtMs === undefined) throw new ScheduleSkip('Skipped: the ready-by time does not exist on this date.');
    const deadline = resolveSmartTaskWriteDeadline({ ...request, deadlineAtMs }, timeZone, Date.now());
    if (!deadline.ok) throw new ScheduleSkip('Skipped: the ready-by time had already passed.');
    const candidate = buildValidSmartTaskCandidate(request, deadline.deadlineAtMs);
    if (!candidate) throw new Error('The task target is invalid.');
    const result = this.host.createNewDeferredObjective(request.deviceId, {
      ...candidate, scheduleSource: { id: schedule.id, name: schedule.name },
    });
    if (!result.ok) {
      if (result.reason === 'task_exists') {
        throw new ScheduleSkip('Skipped: this device already has a Smart task.', true);
      }
      throw new Error(CREATE_FAILURES[result.reason]);
    }
  }
}
