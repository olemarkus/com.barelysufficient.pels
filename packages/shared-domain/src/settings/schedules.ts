import type { Schedule, ScheduleCommand, ScheduleModeCondition } from '../../../contracts/src/schedules';
import type { SmartTaskCandidateDevice } from '../../../contracts/src/smartTaskEdit';
import { isUnknownRecord } from '../recordGuards';

export const MAX_SCHEDULES = 100;
export const SCHEDULE_DELETION = { deleted: true } as const;
export const isScheduleDeletion = (value: unknown): boolean => isUnknownRecord(value)
  && Object.keys(value).length === 1 && value.deleted === true;

export const isScheduleDate = (date: string): boolean => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  const instant = Date.parse(`${date}T12:00:00Z`);
  return Number.isFinite(instant) && new Date(instant).toISOString().slice(0, 10) === date;
};
export const scheduleWeekday = (date: string): number => new Date(`${date}T12:00:00Z`).getUTCDay() || 7;

const text = (value: unknown, max: number): string => (
  typeof value === 'string' && value.trim().length <= max ? value.trim() : ''
);
export const isScheduleId = (id: unknown): id is string => (
  typeof id === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(id)
);

const parseCondition = (raw: unknown): ScheduleModeCondition => {
  if (!isUnknownRecord(raw)) throw new Error('Choose a mode condition');
  if (raw.type === 'any') return { type: 'any' };
  if ((raw.type !== 'include' && raw.type !== 'exclude') || !Array.isArray(raw.modes)
    || raw.modes.length < 1 || raw.modes.length > 100
    || !raw.modes.every((mode) => typeof mode === 'string' && text(mode, 100))) {
    throw new Error('Choose the modes for this condition');
  }
  return { type: raw.type, modes: [...new Set(raw.modes as string[])] };
};

const parseRepeat = (raw: unknown): Schedule['repeat'] => {
  if (!isUnknownRecord(raw)) throw new Error('Choose valid schedule days');
  if (raw.type === 'once' && typeof raw.date === 'string' && isScheduleDate(raw.date)) {
    return { type: 'once', date: raw.date };
  }
  if (raw.type === 'weekly' && Array.isArray(raw.days) && raw.days.length > 0
    && raw.days.length <= 7 && raw.days.every((day) => Number.isInteger(day) && day >= 1 && day <= 7)) {
    return { type: 'weekly', days: [...new Set(raw.days as number[])].sort((a, b) => a - b) };
  }
  throw new Error('Choose valid schedule days');
};

const isTaskKind = (kind: unknown): kind is SmartTaskCandidateDevice['kind'] => (
  kind === 'temperature' || kind === 'ev_soc' || kind === 'energy'
);
const isLocalTime = (value: unknown): value is string => typeof value === 'string'
  && /^([01]\d|2[0-3]):[0-5]\d$/.test(value);

const parseTask = (task: unknown): Extract<Schedule['action'], { type: 'task' }>['task'] => {
  if (!isUnknownRecord(task) || !text(task.deviceId, 200) || !isTaskKind(task.kind)
    || typeof task.target !== 'number' || !Number.isFinite(task.target)
    || !isLocalTime(task.readyByLocalTime) || task.deadlineAtMs !== undefined) throw new Error('Invalid Smart task');
  const permissions = ['exemptFromBudget', 'limitLowerPriorityDevices', 'pauseLowerPriorityDevices'];
  if (permissions.some((key) => task[key] !== undefined && typeof task[key] !== 'boolean')) {
    throw new Error('Invalid Smart task permissions');
  }
  return {
    deviceId: text(task.deviceId, 200), kind: task.kind, target: task.target,
    readyByLocalTime: task.readyByLocalTime, exemptFromBudget: task.exemptFromBudget === true,
    limitLowerPriorityDevices: task.limitLowerPriorityDevices === true,
    pauseLowerPriorityDevices: task.pauseLowerPriorityDevices === true,
  };
};

const parseAction = (raw: unknown): Schedule['action'] => {
  if (!isUnknownRecord(raw)) throw new Error('Choose a schedule action');
  if (raw.type === 'mode' && text(raw.mode, 100)) return { type: 'mode', mode: text(raw.mode, 100) };
  if (raw.type === 'task') return { type: 'task', task: parseTask(raw.task) };
  throw new Error('Choose a schedule action');
};

export const parseSchedule = (raw: unknown): Schedule => {
  if (!isUnknownRecord(raw) || !isScheduleId(raw.id) || !text(raw.name, 60)
    || typeof raw.enabled !== 'boolean' || !isLocalTime(raw.at)) throw new Error('Invalid schedule');
  return {
    id: raw.id, name: text(raw.name, 60), enabled: raw.enabled, at: raw.at,
    repeat: parseRepeat(raw.repeat), condition: parseCondition(raw.condition), action: parseAction(raw.action),
  };
};

export const parseScheduleCommand = (raw: unknown): ScheduleCommand => {
  if (!isUnknownRecord(raw)) throw new Error('Invalid schedule request');
  if (raw.type === 'save') return { type: 'save', schedule: parseSchedule(raw.schedule) };
  if (raw.type === 'delete' && isScheduleId(raw.id)) return { type: 'delete', id: raw.id };
  if (typeof raw.enabled !== 'boolean') throw new Error('Choose On or Off');
  if (raw.type === 'set_enabled' && isScheduleId(raw.id)) {
    return { type: 'set_enabled', id: raw.id, enabled: raw.enabled };
  }
  if (raw.type === 'set_mode_schedules_enabled') return { type: raw.type, enabled: raw.enabled };
  if (raw.type === 'set_device_schedules_enabled' && text(raw.deviceId, 200)) {
    return { type: raw.type, deviceId: text(raw.deviceId, 200), enabled: raw.enabled };
  }
  throw new Error('Invalid schedule request');
};

export const scheduleEligibilityReason = (
  schedule: Schedule,
  modes: readonly string[],
  devices: readonly SmartTaskCandidateDevice[],
): string => {
  if (schedule.condition.type !== 'any' && schedule.condition.modes.some((mode) => !modes.includes(mode))) {
    return 'A mode in this condition is no longer available. Edit the schedule.';
  }
  if (schedule.action.type === 'mode') {
    return modes.includes(schedule.action.mode) ? '' : 'This mode is no longer available. Edit the schedule.';
  }
  const { task } = schedule.action;
  const device = devices.find((entry) => entry.deviceId === task.deviceId && entry.kind === task.kind);
  if (!device) return 'This device is not available for this Smart task. Edit the schedule.';
  if (task.target < device.goalMin || task.target > device.goalMax) return 'The target is outside this device’s range.';
  return '';
};

const repeatsOverlap = (left: Schedule['repeat'], right: Schedule['repeat']): boolean => {
  if (left.type === 'weekly' && right.type === 'weekly') return left.days.some((day) => right.days.includes(day));
  if (left.type === 'once' && right.type === 'once') return left.date === right.date;
  if (left.type === 'weekly' && right.type === 'once') return left.days.includes(scheduleWeekday(right.date));
  return left.type === 'once' && right.type === 'weekly' && right.days.includes(scheduleWeekday(left.date));
};

export const scheduleConflict = (
  schedule: Schedule,
  schedules: readonly Schedule[],
): boolean => schedules.some((other) => {
  if (schedule.id === other.id || !schedule.enabled || !other.enabled || schedule.at !== other.at) return false;
  const sameTarget = schedule.action.type === 'mode' ? other.action.type === 'mode'
    : other.action.type === 'task' && other.action.task.deviceId === schedule.action.task.deviceId;
  return sameTarget && repeatsOverlap(schedule.repeat, other.repeat);
});

/** Conflict at one occurrence, so a future one-off never blocks unrelated earlier days. */
export const scheduleConflictOnDate = (schedule: Schedule, schedules: readonly Schedule[], date: string): boolean => {
  const onDate = (repeat: Schedule['repeat']): boolean => repeat.type === 'once'
    ? repeat.date === date : repeat.days.includes(scheduleWeekday(date));
  return scheduleConflict(schedule, schedules.filter((other) => onDate(other.repeat)));
};
