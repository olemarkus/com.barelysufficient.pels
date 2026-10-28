import type { ScheduleService } from '../lib/schedules/scheduleService';
import type { FlowAutocompleteResult, FlowHomeyLike } from '../lib/utils/types';
import type { Schedule } from '../packages/contracts/src/schedules';
import type { SmartTaskCandidateDevice } from '../packages/contracts/src/smartTaskEdit';
import { buildDeviceAutocompleteOptions } from './deviceArgs';
import { readFlowDeviceArg, readFlowStringArg } from './flowArgParsers';

type ScheduleCardsOwner = Pick<ScheduleService, 'read' | 'write'>;
type ScheduleOption = FlowAutocompleteResult & { description: string };

function selectedSchedule(owner: ScheduleCardsOwner, args: unknown): Schedule {
  const id = readFlowStringArg(args, 'schedule');
  if (!id) throw new Error('Select a schedule.');
  const entry = owner.read().entries.find((candidate) => candidate.schedule.id === id);
  if (!entry) throw new Error('This schedule no longer exists. Select a saved schedule.');
  return entry.schedule;
}

function scheduleDescription(schedule: Schedule, devices: readonly SmartTaskCandidateDevice[]): string {
  if (schedule.action.type === 'mode') return `Change mode to ${schedule.action.mode} at ${schedule.at}`;
  const task = schedule.action.task;
  const device = devices.find((candidate) => candidate.deviceId === task.deviceId);
  const target = task.target;
  const goal = device ? `${target}${device.unitSymbol}` : `${target}`;
  return `${device ? device.deviceName : 'Unavailable device'} · ${goal} · Create at ${schedule.at}`;
}

/** Flow controls use the same named schedules and enable flags as the settings UI. */
export function registerScheduleFlowCards(
  homey: FlowHomeyLike,
  schedules: ScheduleCardsOwner,
  getTaskDevices: () => readonly SmartTaskCandidateDevice[],
): void {
  const scheduleOptions = async (query: string): Promise<ScheduleOption[]> => {
    const entries = schedules.read().entries;
    const devices = entries.some(({ schedule }) => schedule.action.type === 'task') ? getTaskDevices() : [];
    const search = query.trim().toLocaleLowerCase();
    return entries.map(({ schedule }) => ({
      id: schedule.id,
      name: schedule.name,
      description: scheduleDescription(schedule, devices),
    })).filter((option) => `${option.name} ${option.description}`.toLocaleLowerCase().includes(search))
      .sort((a, b) => a.name.localeCompare(b.name));
  };

  for (const [id, enabled] of [['enable_schedule', true], ['disable_schedule', false]] as const) {
    const card = homey.flow.getActionCard(id);
    card.registerArgumentAutocompleteListener('schedule', scheduleOptions);
    card.registerRunListener(async (args: unknown) => {
      const schedule = selectedSchedule(schedules, args);
      schedules.write({ type: 'set_enabled', id: schedule.id, enabled });
      return true;
    });
  }

  for (const [id, enabled] of [['enable_mode_schedules', true], ['disable_mode_schedules', false]] as const) {
    homey.flow.getActionCard(id).registerRunListener(async () => {
      schedules.write({ type: 'set_mode_schedules_enabled', enabled });
      return true;
    });
  }

  const deviceOptions = async (query: string): Promise<FlowAutocompleteResult[]> => {
    const scheduled = new Set(schedules.read().entries.flatMap(({ schedule }) => (
      schedule.action.type === 'task' ? [schedule.action.task.deviceId] : []
    )));
    return buildDeviceAutocompleteOptions(getTaskDevices()
      .filter((device) => scheduled.has(device.deviceId))
      .map((device) => ({ id: device.deviceId, name: device.deviceName })), query);
  };
  for (const [id, enabled] of [
    ['enable_device_task_schedules', true], ['disable_device_task_schedules', false],
  ] as const) {
    const card = homey.flow.getActionCard(id);
    card.registerArgumentAutocompleteListener('device', deviceOptions);
    card.registerRunListener(async (args: unknown) => {
      const deviceId = readFlowDeviceArg(args);
      if (!deviceId) throw new Error('Select a device.');
      schedules.write({ type: 'set_device_schedules_enabled', deviceId, enabled });
      return true;
    });
  }

  const condition = homey.flow.getConditionCard('schedule_is_enabled');
  condition.registerArgumentAutocompleteListener('schedule', scheduleOptions);
  condition.registerRunListener(async (args: unknown) => selectedSchedule(schedules, args).enabled);
}
