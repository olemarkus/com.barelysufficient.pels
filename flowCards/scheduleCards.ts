import type { ScheduleService } from '../lib/schedules/scheduleService';
import type { FlowAutocompleteResult, FlowHomeyLike } from '../lib/utils/types';
import type { Schedule } from '../packages/contracts/src/schedules';
import type {
  SettingsUiSmartTaskDevicesResponse, SmartTaskCandidateDevice,
} from '../packages/contracts/src/smartTaskEdit';
import { buildDeviceAutocompleteOptions } from './deviceArgs';
import { readFlowDeviceArg, readFlowStringArg } from './flowArgParsers';
import { deadlineLabels } from '../packages/shared-domain/src/smartTaskCopy/deadlineLabels';

type ScheduleCardsOwner = Pick<ScheduleService, 'definitions' | 'lookup' | 'write'>;
type ScheduleOption = FlowAutocompleteResult & { description: string };

function selectedSchedule(owner: ScheduleCardsOwner, args: unknown): Schedule {
  const id = readFlowStringArg(args, 'schedule');
  if (!id) throw new Error('Select a schedule.');
  return owner.lookup(id);
}

function scheduleDescription(schedule: Schedule, catalog: SettingsUiSmartTaskDevicesResponse): string {
  if (schedule.action.type === 'mode') return `Change mode to ${schedule.action.mode} at ${schedule.at}`;
  const task = schedule.action.task;
  const device = catalog.state === 'ready'
    ? catalog.devices.find((candidate) => candidate.deviceId === task.deviceId) : undefined;
  const target = task.target;
  const goal = `${target}${deadlineLabels(task.kind).targetUnit}`;
  const name = device?.deviceName ?? (catalog.state === 'ready' ? 'Unavailable device' : 'Device details unavailable');
  return `${name} · ${goal} · Create at ${schedule.at}`;
}

/** Flow controls use the same named schedules and enable flags as the settings UI. */
export function registerScheduleFlowCards(
  homey: FlowHomeyLike,
  schedules: ScheduleCardsOwner,
  getTaskDevices: () => readonly SmartTaskCandidateDevice[],
): void {
  const taskDeviceLabels = (): SettingsUiSmartTaskDevicesResponse => {
    try { return { state: 'ready', devices: [...getTaskDevices()] }; } catch { return { state: 'unavailable' }; }
  };
  const scheduleOptions = async (query: string): Promise<ScheduleOption[]> => {
    const definitions = schedules.definitions();
    const catalog: SettingsUiSmartTaskDevicesResponse = definitions.some((schedule) => schedule.action.type === 'task')
      ? taskDeviceLabels() : { state: 'ready', devices: [] };
    const search = query.trim().toLocaleLowerCase();
    return definitions.map((schedule) => ({
      id: schedule.id,
      name: schedule.name,
      description: scheduleDescription(schedule, catalog),
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
    const scheduled = new Set(schedules.definitions().flatMap((schedule) => (
      schedule.action.type === 'task' ? [schedule.action.task.deviceId] : []
    )));
    if (scheduled.size === 0) return [];
    const catalog = taskDeviceLabels();
    return buildDeviceAutocompleteOptions([...scheduled].map((id) => {
      const device = catalog.state === 'ready' ? catalog.devices.find((entry) => entry.deviceId === id) : undefined;
      return { id, name: device?.deviceName || `Device details unavailable · ${id}` };
    }), query);
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
