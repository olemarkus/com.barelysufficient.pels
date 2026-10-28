import type { Schedule, ScheduleCommand, SchedulesSnapshot } from '../../../contracts/src/schedules.ts';
import type { SettingsUiDevicesPayload } from '../../../contracts/src/settingsUi/devices.ts';
import { SETTINGS_UI_DEVICES_PATH } from '../../../contracts/src/settingsUi/paths.ts';
import { scheduleInstant } from '../../../shared-domain/src/scheduleTime.ts';
import {
  parseSchedule, scheduleConflict, MAX_SCHEDULES, SCHEDULE_DELETION,
} from '../../../shared-domain/src/settings/schedules.ts';
import { callApi, setSetting } from './homey.ts';

type DefinitionCommand = Extract<ScheduleCommand, { type: 'save' | 'set_enabled' }>;

/** Read owner-resolved schedules from the existing device projection. */
export const readSchedules = async (): Promise<SchedulesSnapshot> => {
  const response = await callApi<SettingsUiDevicesPayload>('GET', SETTINGS_UI_DEVICES_PATH);
  if (!response.schedules.ok) throw new Error(response.schedules.error);
  return response.schedules.data;
};

const assertFutureOccurrence = (command: DefinitionCommand, schedule: Schedule, timeZone: string): void => {
  if (schedule.repeat.type !== 'once') return;
  if (command.type === 'set_enabled' && !command.enabled) return;
  const atMs = scheduleInstant(schedule.repeat.date, schedule.at, timeZone);
  if (atMs === undefined || atMs <= Date.now()) {
    throw new Error('Choose a future date and time that exists in the Homey time zone.');
  }
};

const definitionForWrite = (command: DefinitionCommand, read: SchedulesSnapshot): Schedule => {
  const isNew = command.type === 'save'
    && !read.entries.some((entry) => entry.schedule.id === command.schedule.id);
  if (isNew && read.entries.length >= MAX_SCHEDULES) throw new Error(`Use at most ${MAX_SCHEDULES} schedules.`);
  const definition = command.type === 'save' ? command.schedule : {
    ...read.entries.find((entry) => entry.schedule.id === command.id)?.schedule,
    enabled: command.enabled,
  };
  const schedule = parseSchedule(definition);
  assertFutureOccurrence(command, schedule, read.timeZone);
  const pending = read.entries.filter((entry) => entry.state !== 'finished').map((entry) => entry.schedule);
  if (scheduleConflict(schedule, pending)) {
    throw new Error('Another schedule performs this action at the same time. Choose another time or day.');
  }
  return schedule;
};

const writeConfiguration = async (command: ScheduleCommand, read: SchedulesSnapshot): Promise<void> => {
  switch (command.type) {
    case 'save':
    case 'set_enabled': {
      const schedule = definitionForWrite(command, read);
      await setSetting(`schedule.${schedule.id}`, schedule);
      return;
    }
    case 'delete':
      await setSetting(`schedule.${command.id}`, SCHEDULE_DELETION);
      return;
    case 'set_mode_schedules_enabled':
      await setSetting('schedule_modes_enabled', command.enabled);
      return;
    case 'set_device_schedules_enabled':
      await setSetting(`schedule_task_enabled.${command.deviceId}`, command.enabled);
  }
};

const verifySavedSchedule = (schedule: Schedule, read: SchedulesSnapshot): void => {
  const entry = read.entries.find((candidate) => candidate.schedule.id === schedule.id);
  if (!entry) throw new Error('The schedule could not be confirmed.');
  if (entry.state === 'invalid' || entry.state === 'finished') {
    throw new Error(entry.reason || 'The schedule could not be confirmed.');
  }
  if (JSON.stringify(parseSchedule(entry.schedule)) !== JSON.stringify(parseSchedule(schedule))) {
    throw new Error('The saved schedule could not be confirmed. Refresh and try again.');
  }
};

const acknowledgeWrite = (command: ScheduleCommand, read: SchedulesSnapshot): void => {
  switch (command.type) {
    case 'save':
      verifySavedSchedule(command.schedule, read);
      return;
    case 'delete':
      if (read.entries.some((entry) => entry.schedule.id === command.id)) {
        throw new Error('The deletion could not be confirmed.');
      }
      return;
    case 'set_enabled':
      if (read.entries.find((entry) => entry.schedule.id === command.id)?.schedule.enabled !== command.enabled) {
        throw new Error('The schedule change could not be confirmed.');
      }
      return;
    case 'set_mode_schedules_enabled':
      if (read.controls.modeChangesEnabled !== command.enabled) {
        throw new Error('The mode schedule switch could not be confirmed.');
      }
      return;
    case 'set_device_schedules_enabled':
      if (read.controls.disabledTaskDeviceIds.includes(command.deviceId) === command.enabled) {
        throw new Error('The device schedule switch could not be confirmed.');
      }
  }
};

/** Per-key settings writes are complete only after a fresh owner projection acknowledges them. */
export const persistScheduleCommand = async (
  command: ScheduleCommand,
  read: SchedulesSnapshot,
): Promise<SchedulesSnapshot> => {
  await writeConfiguration(command, read);
  const next = await readSchedules();
  acknowledgeWrite(command, next);
  return next;
};
