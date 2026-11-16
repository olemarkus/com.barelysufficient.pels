import type { Schedule, ScheduleAction, ScheduleEntry, ScheduleRepeat } from '../../../contracts/src/schedules.ts';
import type { SmartTaskCandidateDevice } from '../../../contracts/src/smartTaskEdit.ts';
import { deadlineLabels } from '../../../shared-domain/src/smartTaskCopy/deadlineLabels.ts';
import { resolveSmartTaskCandidateGoal } from '../../../shared-domain/src/smartTaskCandidateGoal.ts';
import { scheduleActionDeviceId } from '../../../shared-domain/src/settings/schedules.ts';
import type { SmartTaskEditPermissions } from './smartTaskEdit.ts';
import { isScheduleModeAvailable } from './scheduleModeReferences.ts';
import { parseSmartTaskGoal, SMART_TASK_READY_BY_PATTERN } from './smartTaskDraft.ts';

export type ScheduleActionType = ScheduleAction['type'];
const DAY_MINUTES = 24 * 60;
const clockMinutes = (time: string): number => Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));
const clockTime = (minutes: number): string => {
  const wrapped = ((minutes % DAY_MINUTES) + DAY_MINUTES) % DAY_MINUTES;
  return `${String(Math.floor(wrapped / 60)).padStart(2, '0')}:${String(wrapped % 60).padStart(2, '0')}`;
};
/** How long an override from `at` until `until` lasts; an end at or before the start is the next day's. */
export const scheduleOverrideMinutes = (at: string, until: string): number => {
  const minutes = clockMinutes(until) - clockMinutes(at);
  return minutes > 0 ? minutes : minutes + DAY_MINUTES;
};
/** When an override starting at `at` and lasting `minutes` ends (`HH:MM`). */
export const scheduleOverrideEnd = (at: string, minutes: number): string => clockTime(clockMinutes(at) + minutes);
/** The devices an override can be scheduled for: those PELS sets a temperature on. */
export const scheduleOverrideDevices = (
  devices: readonly SmartTaskCandidateDevice[],
): SmartTaskCandidateDevice[] => (
  devices.filter((device) => device.overridable === true
    && resolveSmartTaskCandidateGoal(device, 'temperature') !== undefined)
);

export const SCHEDULE_DAYS = [
  { value: 1, label: 'Mon' }, { value: 2, label: 'Tue' }, { value: 3, label: 'Wed' },
  { value: 4, label: 'Thu' }, { value: 5, label: 'Fri' }, { value: 6, label: 'Sat' }, { value: 7, label: 'Sun' },
] as const;
export type ScheduleRepeatChoice = 'daily' | 'weekdays' | 'weekends' | 'custom' | 'once';
export type ScheduleDraft = {
  id: string;
  name: string;
  enabled: boolean;
  actionType: ScheduleActionType;
  mode: string;
  deviceId: string;
  taskKind: SmartTaskCandidateDevice['kind'] | null;
  target: string;
  readyBy: string;
  permissions: SmartTaskEditPermissions;
  /** The override's temperature and the time it ends (`HH:MM`). */
  overrideTarget: string;
  overrideUntil: string;
  at: string;
  repeat: ScheduleRepeatChoice;
  days: number[];
  date: string;
  conditionType: 'any' | 'include' | 'exclude';
  conditionModes: string[];
};

const EMPTY_PERMISSIONS: SmartTaskEditPermissions = {
  exemptFromBudget: false, limitLowerPriorityDevices: false, pauseLowerPriorityDevices: false,
};
export const daysForRepeat = (repeat: ScheduleRepeatChoice): number[] => {
  if (repeat === 'weekdays') return [1, 2, 3, 4, 5];
  if (repeat === 'weekends') return [6, 7];
  return [1, 2, 3, 4, 5, 6, 7];
};
const repeatChoice = (repeat: ScheduleRepeat): ScheduleRepeatChoice => {
  if (repeat.type === 'once') return 'once';
  const days = [...repeat.days].sort().join(',');
  if (days === '1,2,3,4,5,6,7') return 'daily';
  if (days === '1,2,3,4,5') return 'weekdays';
  if (days === '6,7') return 'weekends';
  return 'custom';
};
export const scheduleRepeatLabel = (repeat: ScheduleRepeat): string => {
  if (repeat.type === 'once') return repeat.date;
  const choice = repeatChoice(repeat);
  if (choice === 'daily') return 'Every day';
  if (choice === 'weekdays') return 'Mon–Fri';
  if (choice === 'weekends') return 'Sat–Sun';
  return SCHEDULE_DAYS.filter((day) => repeat.days.includes(day.value)).map((day) => day.label).join(', ');
};

/** The name a new schedule carries from its action until the owner types another. */
export const automaticScheduleName = (draft: ScheduleDraft, devices: readonly SmartTaskCandidateDevice[]): string => {
  if (draft.actionType === 'mode') return `${draft.mode} mode`;
  const device = devices.find((candidate) => candidate.deviceId === draft.deviceId);
  if (!device) return draft.name;
  return draft.actionType === 'override' ? `${device.deviceName} override` : `${device.deviceName} task`;
};

const performsSameAction = (draft: ScheduleDraft, schedule: Schedule): boolean => (
  schedule.action.type === draft.actionType
    && (draft.actionType === 'mode' || scheduleActionDeviceId(schedule.action) === draft.deviceId)
);
const START_HOURS: Record<ScheduleActionType, number> = { task: 18, mode: 22, override: 6 };

/**
 * The first whole hour from the action's usual time that no other schedule
 * performing the same action uses, so a new schedule never starts out in
 * conflict. Repeat days are not compared: a free time is free on every day.
 */
export const automaticScheduleTime = (draft: ScheduleDraft, schedules: readonly Schedule[]): string => {
  const taken = new Set(schedules
    .filter((schedule) => schedule.id !== draft.id && schedule.enabled && performsSameAction(draft, schedule))
    .map((schedule) => schedule.at));
  const startHour = START_HOURS[draft.actionType];
  const free = Array.from({ length: 24 }, (_, offset) => `${String((startHour + offset) % 24).padStart(2, '0')}:00`)
    .find((time) => !taken.has(time));
  return free ?? `${startHour}:00`;
};

export const createScheduleDraft = (
  device: SmartTaskCandidateDevice | undefined,
  mode: string,
  today: string,
  schedules: readonly Schedule[],
): ScheduleDraft => {
  const draft: ScheduleDraft = {
    id: crypto.randomUUID(),
    name: device ? `${device.deviceName} task` : `${mode} mode`,
    enabled: true,
    actionType: device ? 'task' : 'mode',
    mode,
    deviceId: device?.deviceId ?? '',
    taskKind: device?.kind ?? null,
    target: device ? String(device.defaultGoal) : '',
    readyBy: '07:00',
    permissions: { ...EMPTY_PERMISSIONS },
    overrideTarget: '',
    overrideUntil: '',
    at: '',
    repeat: 'daily',
    days: daysForRepeat('daily'),
    date: today,
    conditionType: 'any',
    conditionModes: [],
  };
  return { ...draft, at: automaticScheduleTime(draft, schedules) };
};

/** A new override's end, an hour after its trigger time, until the owner chooses one. */
export const withOverrideEnd = (draft: ScheduleDraft): ScheduleDraft => (
  draft.actionType === 'override' && draft.overrideUntil === '' && SMART_TASK_READY_BY_PATTERN.test(draft.at)
    ? { ...draft, overrideUntil: clockTime(clockMinutes(draft.at) + 60) } : draft
);

const usualOverrideTarget = (device: SmartTaskCandidateDevice): string => (
  device.kind === 'temperature' ? String(device.defaultGoal) : ''
);

/** The draft as an override for a device, at the given temperature or the device's usual goal. */
export const overrideDraftPatch = (
  draft: ScheduleDraft,
  device: SmartTaskCandidateDevice,
  temperatureC: number | null = null,
): Pick<ScheduleDraft, 'actionType' | 'deviceId' | 'overrideTarget' | 'overrideUntil'> => ({
  actionType: 'override',
  deviceId: device.deviceId,
  overrideTarget: temperatureC !== null ? String(temperatureC) : usualOverrideTarget(device),
  overrideUntil: draft.overrideUntil,
});

type ActionDraftFields = Pick<ScheduleDraft,
  'mode' | 'deviceId' | 'target' | 'taskKind' | 'readyBy' | 'permissions' | 'overrideTarget' | 'overrideUntil'>;
const NO_ACTION_FIELDS: ActionDraftFields = {
  mode: '', deviceId: '', target: '', taskKind: null, readyBy: '07:00', permissions: { ...EMPTY_PERMISSIONS },
  overrideTarget: '', overrideUntil: '',
};
const actionDraftFields = (schedule: Schedule): ActionDraftFields => {
  const { action } = schedule;
  if (action.type === 'mode') return { ...NO_ACTION_FIELDS, mode: action.mode };
  if (action.type === 'override') {
    return {
      ...NO_ACTION_FIELDS, deviceId: action.deviceId, overrideTarget: String(action.setting.targetC),
      overrideUntil: scheduleOverrideEnd(schedule.at, action.minutes),
    };
  }
  const { task } = action;
  return {
    ...NO_ACTION_FIELDS, deviceId: task.deviceId, target: String(task.target), taskKind: task.kind,
    readyBy: task.readyByLocalTime,
    permissions: {
      exemptFromBudget: task.exemptFromBudget === true,
      limitLowerPriorityDevices: task.limitLowerPriorityDevices === true,
      pauseLowerPriorityDevices: task.pauseLowerPriorityDevices === true,
    },
  };
};

export const editScheduleDraft = (schedule: Schedule, today: string): ScheduleDraft => ({
  id: schedule.id, name: schedule.name, enabled: schedule.enabled,
  actionType: schedule.action.type,
  ...actionDraftFields(schedule),
  at: schedule.at, repeat: repeatChoice(schedule.repeat),
  days: schedule.repeat.type === 'weekly' ? [...schedule.repeat.days] : daysForRepeat('daily'),
  date: schedule.repeat.type === 'once' ? schedule.repeat.date : today,
  conditionType: schedule.condition.type,
  conditionModes: schedule.condition.type === 'any' ? [] : [...schedule.condition.modes],
});

type TaskActionDraftResult = { ok: true; action: ScheduleAction } | { ok: false; error: string };
const taskActionFromDraft = (
  draft: ScheduleDraft,
  devices: readonly SmartTaskCandidateDevice[],
): TaskActionDraftResult => {
  const device = devices.find((candidate) => candidate.deviceId === draft.deviceId);
  if (!device) return { ok: false, error: 'Choose an available device for this task.' };
  const goal = draft.taskKind === null ? undefined : resolveSmartTaskCandidateGoal(device, draft.taskKind);
  if (!goal) {
    return {
      ok: false,
      error: 'This target is not available for this device. Choose another target or device.',
    };
  }
  const target = parseSmartTaskGoal(draft.target);
  if (target === null || target < goal.goalMin || target > goal.goalMax) {
    return {
      ok: false, error: `Choose a target between ${goal.goalMin} and ${goal.goalMax} ${goal.unitSymbol}.`,
    };
  }
  if (!SMART_TASK_READY_BY_PATTERN.test(draft.readyBy)) return { ok: false, error: 'Choose a valid ready-by time.' };
  return {
    ok: true,
    action: {
      type: 'task',
      task: {
        deviceId: device.deviceId, kind: goal.kind, target, readyByLocalTime: draft.readyBy,
        ...draft.permissions,
      },
    },
  };
};

const overrideActionFromDraft = (
  draft: ScheduleDraft,
  devices: readonly SmartTaskCandidateDevice[],
): TaskActionDraftResult => {
  const [device] = scheduleOverrideDevices(devices.filter((candidate) => candidate.deviceId === draft.deviceId));
  const goal = device && resolveSmartTaskCandidateGoal(device, 'temperature');
  if (!device || !goal) return { ok: false, error: 'Choose an available device for this override.' };
  const targetC = parseSmartTaskGoal(draft.overrideTarget);
  if (targetC === null || targetC < goal.goalMin || targetC > goal.goalMax) {
    return { ok: false, error: `Choose a temperature between ${goal.goalMin} and ${goal.goalMax} °C.` };
  }
  if (!SMART_TASK_READY_BY_PATTERN.test(draft.overrideUntil)) {
    return { ok: false, error: 'Choose a valid end time.' };
  }
  return {
    ok: true,
    action: {
      type: 'override', deviceId: device.deviceId, setting: { type: 'temperature', targetC },
      minutes: scheduleOverrideMinutes(draft.at, draft.overrideUntil),
    },
  };
};

const actionFromDraft = (
  draft: ScheduleDraft,
  devices: readonly SmartTaskCandidateDevice[],
  modeAvailable: boolean,
): TaskActionDraftResult => {
  if (draft.actionType === 'override') return overrideActionFromDraft(draft, devices);
  if (draft.actionType === 'task') return taskActionFromDraft(draft, devices);
  return modeAvailable
    ? { ok: true, action: { type: 'mode', mode: draft.mode } }
    : { ok: false, error: 'Choose an available mode.' };
};

export type ScheduleDraftResult = { ok: true; schedule: Schedule } | { ok: false; error: string };
export const buildScheduleFromDraft = (
  draft: ScheduleDraft,
  devices: readonly SmartTaskCandidateDevice[],
  modes: readonly string[],
  modeReferences: Readonly<ScheduleEntry['modeReferences']>,
): ScheduleDraftResult => {
  if (!draft.name.trim()) return { ok: false, error: 'Give this schedule a name.' };
  if (!SMART_TASK_READY_BY_PATTERN.test(draft.at)) return { ok: false, error: 'Choose a valid trigger time.' };
  if (draft.repeat === 'once' && !/^\d{4}-\d{2}-\d{2}$/.test(draft.date)) {
    return { ok: false, error: 'Choose a date.' };
  }
  if (draft.repeat !== 'once' && draft.days.length === 0) return { ok: false, error: 'Choose at least one day.' };
  if (draft.conditionType !== 'any' && (
    draft.conditionModes.length === 0
    || draft.conditionModes.some((mode) => !isScheduleModeAvailable(mode, modes, modeReferences))
  )) {
    return { ok: false, error: 'Choose the modes this condition should use.' };
  }
  const common = {
    id: draft.id, name: draft.name.trim(), enabled: draft.enabled, at: draft.at,
    repeat: draft.repeat === 'once'
      ? { type: 'once' as const, date: draft.date }
      : { type: 'weekly' as const, days: [...draft.days].sort() },
    condition: draft.conditionType === 'any'
      ? { type: 'any' as const }
      : { type: draft.conditionType, modes: [...draft.conditionModes] },
  };
  const action = actionFromDraft(draft, devices, isScheduleModeAvailable(draft.mode, modes, modeReferences));
  return action.ok ? { ok: true, schedule: { ...common, action: action.action } } : action;
};

export const scheduleReadyByDay = (at: string, readyBy: string): string => (
  readyBy <= at ? 'the following day' : 'the same day'
);

export const scheduleTaskUnit = (kind: SmartTaskCandidateDevice['kind']): SmartTaskCandidateDevice['unitSymbol'] => (
  deadlineLabels(kind).targetUnit
);
