import type { Schedule, ScheduleAction, ScheduleEntry, ScheduleRepeat } from '../../../contracts/src/schedules.ts';
import type { SmartTaskCandidateDevice } from '../../../contracts/src/smartTaskEdit.ts';
import { deadlineLabels } from '../../../shared-domain/src/smartTaskCopy/deadlineLabels.ts';
import { resolveSmartTaskCandidateGoal } from '../../../shared-domain/src/smartTaskCandidateGoal.ts';
import type { SmartTaskEditPermissions } from './smartTaskEdit.ts';
import { isScheduleModeAvailable } from './scheduleModeReferences.ts';
import { parseSmartTaskGoal, SMART_TASK_READY_BY_PATTERN } from './smartTaskDraft.ts';

export const SCHEDULE_DAYS = [
  { value: 1, label: 'Mon' }, { value: 2, label: 'Tue' }, { value: 3, label: 'Wed' },
  { value: 4, label: 'Thu' }, { value: 5, label: 'Fri' }, { value: 6, label: 'Sat' }, { value: 7, label: 'Sun' },
] as const;
export type ScheduleRepeatChoice = 'daily' | 'weekdays' | 'weekends' | 'custom' | 'once';
export type ScheduleDraft = {
  id: string;
  name: string;
  enabled: boolean;
  actionType: 'mode' | 'task';
  mode: string;
  deviceId: string;
  taskKind: SmartTaskCandidateDevice['kind'] | null;
  target: string;
  readyBy: string;
  permissions: SmartTaskEditPermissions;
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
  return device ? `${device.deviceName} task` : draft.name;
};

const performsSameAction = (draft: ScheduleDraft, schedule: Schedule): boolean => (
  draft.actionType === 'mode' ? schedule.action.type === 'mode'
    : schedule.action.type === 'task' && schedule.action.task.deviceId === draft.deviceId
);

/**
 * The first whole hour from the action's usual time that no other schedule
 * performing the same action uses, so a new schedule never starts out in
 * conflict. Repeat days are not compared: a free time is free on every day.
 */
export const automaticScheduleTime = (draft: ScheduleDraft, schedules: readonly Schedule[]): string => {
  const taken = new Set(schedules
    .filter((schedule) => schedule.id !== draft.id && schedule.enabled && performsSameAction(draft, schedule))
    .map((schedule) => schedule.at));
  const startHour = draft.actionType === 'task' ? 18 : 22;
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
    at: '',
    repeat: 'daily',
    days: daysForRepeat('daily'),
    date: today,
    conditionType: 'any',
    conditionModes: [],
  };
  return { ...draft, at: automaticScheduleTime(draft, schedules) };
};

export const editScheduleDraft = (schedule: Schedule, today: string): ScheduleDraft => {
  const task = schedule.action.type === 'task' ? schedule.action.task : null;
  return {
    id: schedule.id, name: schedule.name, enabled: schedule.enabled,
    actionType: schedule.action.type,
    mode: schedule.action.type === 'mode' ? schedule.action.mode : '',
    deviceId: task?.deviceId ?? '', target: task ? String(task.target) : '',
    taskKind: task ? task.kind : null,
    readyBy: task?.readyByLocalTime ?? '07:00',
    permissions: {
      exemptFromBudget: task?.exemptFromBudget === true,
      limitLowerPriorityDevices: task?.limitLowerPriorityDevices === true,
      pauseLowerPriorityDevices: task?.pauseLowerPriorityDevices === true,
    },
    at: schedule.at, repeat: repeatChoice(schedule.repeat),
    days: schedule.repeat.type === 'weekly' ? [...schedule.repeat.days] : daysForRepeat('daily'),
    date: schedule.repeat.type === 'once' ? schedule.repeat.date : today,
    conditionType: schedule.condition.type,
    conditionModes: schedule.condition.type === 'any' ? [] : [...schedule.condition.modes],
  };
};

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
  if (draft.actionType === 'mode') {
    if (!isScheduleModeAvailable(draft.mode, modes, modeReferences)) {
      return { ok: false, error: 'Choose an available mode.' };
    }
    return { ok: true, schedule: { ...common, action: { type: 'mode', mode: draft.mode } } };
  }
  const task = taskActionFromDraft(draft, devices);
  return task.ok ? { ok: true, schedule: { ...common, action: task.action } } : task;
};

export const scheduleReadyByDay = (at: string, readyBy: string): string => (
  readyBy <= at ? 'the following day' : 'the same day'
);

export const scheduleTaskUnit = (kind: SmartTaskCandidateDevice['kind']): SmartTaskCandidateDevice['unitSymbol'] => (
  deadlineLabels(kind).targetUnit
);
