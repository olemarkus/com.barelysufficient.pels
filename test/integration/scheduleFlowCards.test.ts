import { beforeEach, describe, expect, it, vi } from 'vitest';
import { registerScheduleFlowCards } from '../../flowCards/scheduleCards';
import type { ScheduleService } from '../../lib/schedules/scheduleService';
import type { FlowHomeyLike } from '../../lib/utils/types';
import type { Schedule, ScheduleEntry, SchedulesSnapshot } from '../../packages/contracts/src/schedules';
import type { SmartTaskCandidateDevice } from '../../packages/contracts/src/smartTaskEdit';
import { partialDouble } from '../helpers/partialDouble';
import { mockHomeyInstance, resetMockHomey } from '../mocks/homey';

const modeSchedule = (): Schedule => ({
  id: 'night-mode', name: 'Night mode', enabled: true, at: '22:00',
  repeat: { type: 'weekly', days: [1, 2, 3, 4, 5] },
  condition: { type: 'any' }, action: { type: 'mode', mode: 'Night' },
});
const taskSchedule = (id = 'morning-water'): Schedule => ({
  id, name: 'Morning hot water', enabled: true, at: '21:00',
  repeat: { type: 'weekly', days: [1, 2, 3, 4, 5, 6, 7] },
  condition: { type: 'any' },
  action: {
    type: 'task',
    task: { deviceId: 'water-heater', kind: 'temperature', target: 65, readyByLocalTime: '06:00' },
  },
});
const entry = (schedule: Schedule, state: ScheduleEntry['state'] = 'on'): ScheduleEntry => ({
  schedule, modeReferences: [], state, reason: '', nextAtMs: 1, nextLabel: 'Tomorrow 21:00', lastResult: '',
});
const waterHeater = (): SmartTaskCandidateDevice => partialDouble<SmartTaskCandidateDevice>({
  deviceId: 'water-heater', deviceName: 'Water heater', unitSymbol: '°C',
});

function register(entries: ScheduleEntry[] = [entry(modeSchedule()), entry(taskSchedule())]) {
  const snapshot: SchedulesSnapshot = {
    timeZone: 'Europe/Oslo', modes: ['Home', 'Night'], entries,
    controls: { modeChangesEnabled: true, disabledTaskDeviceIds: [] },
  };
  const definitions = vi.fn(() => snapshot.entries.map(({ schedule }) => schedule));
  const lookup = vi.fn((id: string) => {
    const found = snapshot.entries.find(({ schedule }) => schedule.id === id);
    if (!found) throw new Error('This schedule no longer exists. Select a saved schedule.');
    return found.schedule;
  });
  const write = vi.fn(() => {});
  const owner: Pick<ScheduleService, 'definitions' | 'lookup' | 'write'> = { definitions, lookup, write };
  const getTaskDevices = vi.fn(() => [waterHeater()]);
  registerScheduleFlowCards(mockHomeyInstance as unknown as FlowHomeyLike, owner, getTaskDevices);
  const run = (id: string, args: unknown = {}) => mockHomeyInstance.flow._actionCardListeners[id](args);
  const autocomplete = (id: string, arg: string, query = '') => (
    mockHomeyInstance.flow._actionCardAutocompleteListeners[id][arg](query)
  );
  return { snapshot, definitions, lookup, write, run, autocomplete, getTaskDevices };
}

describe('schedule Flow cards', () => {
  beforeEach(() => resetMockHomey());

  it('can select a mode schedule when the task-device read is unavailable', async () => {
    const { autocomplete, getTaskDevices } = register([entry(modeSchedule())]);
    getTaskDevices.mockImplementation(() => { throw new Error('Unavailable devices'); });
    await expect(autocomplete('enable_schedule', 'schedule')).resolves.toEqual([
      expect.objectContaining({ id: 'night-mode', name: 'Night mode' }),
    ]);
    expect(getTaskDevices).not.toHaveBeenCalled();
  });

  it('uses stable schedule ids after renaming and offers current names with useful descriptions', async () => {
    const { snapshot, run, autocomplete, write } = register();
    snapshot.entries[0].schedule.name = 'Bedtime';

    await expect(run('disable_schedule', { schedule: { id: 'night-mode', name: 'Night mode' } })).resolves.toBe(true);
    expect(write).toHaveBeenCalledWith({ type: 'set_enabled', id: 'night-mode', enabled: false });
    await expect(autocomplete('enable_schedule', 'schedule', 'bed')).resolves.toEqual([
      { id: 'night-mode', name: 'Bedtime', description: 'Change mode to Night at 22:00' },
    ]);
    await expect(autocomplete('enable_schedule', 'schedule', 'water')).resolves.toEqual([
      { id: 'morning-water', name: 'Morning hot water', description: 'Water heater · 65°C · Create at 21:00' },
    ]);
  });

  it('forwards explicit enable/disable operations instead of toggling or executing an occurrence', async () => {
    const { run, write } = register();

    await run('enable_schedule', { schedule: 'night-mode' });
    await run('enable_schedule', { schedule: 'night-mode' });
    await run('disable_schedule', { schedule: 'night-mode' });
    await run('enable_mode_schedules');
    await run('disable_mode_schedules');
    await run('enable_device_task_schedules', { device: { id: 'water-heater', name: 'Water heater' } });
    await run('disable_device_task_schedules', { device: 'water-heater' });

    expect(write.mock.calls).toEqual([
      [{ type: 'set_enabled', id: 'night-mode', enabled: true }],
      [{ type: 'set_enabled', id: 'night-mode', enabled: true }],
      [{ type: 'set_enabled', id: 'night-mode', enabled: false }],
      [{ type: 'set_mode_schedules_enabled', enabled: true }],
      [{ type: 'set_mode_schedules_enabled', enabled: false }],
      [{ type: 'set_device_schedules_enabled', deviceId: 'water-heater', enabled: true }],
      [{ type: 'set_device_schedules_enabled', deviceId: 'water-heater', enabled: false }],
    ]);
  });

  it('lists each configured task device once and matches its current name', async () => {
    const { autocomplete } = register([
      entry(modeSchedule()), entry(taskSchedule()), entry(taskSchedule('weekend-water')),
    ]);

    await expect(autocomplete('disable_device_task_schedules', 'device', 'WATER')).resolves.toEqual([
      { id: 'water-heater', name: 'Water heater' },
    ]);
    await expect(autocomplete('enable_device_task_schedules', 'device', 'missing')).resolves.toEqual([]);
  });

  it('reports a deleted schedule rather than silently succeeding or answering disabled', async () => {
    const { snapshot, run, write } = register();
    snapshot.entries = [];
    const condition = mockHomeyInstance.flow._conditionCardListeners.schedule_is_enabled;

    await expect(run('disable_schedule', { schedule: 'night-mode' })).rejects.toThrow('no longer exists');
    await expect(condition({ schedule: 'night-mode' })).rejects.toThrow('no longer exists');
    expect(write).not.toHaveBeenCalled();
  });

  it('checks the individual enabled preference while a group pauses the schedule', async () => {
    const { snapshot } = register([entry(modeSchedule(), 'paused')]);
    snapshot.controls.modeChangesEnabled = false;
    const condition = mockHomeyInstance.flow._conditionCardListeners.schedule_is_enabled;

    await expect(condition({ schedule: 'night-mode' })).resolves.toBe(true);
    snapshot.entries[0].schedule.enabled = false;
    await expect(condition({ schedule: { id: 'night-mode' } })).resolves.toBe(false);
  });

  it('keeps configured devices selectable with an explicit unavailable-details label', async () => {
    const { autocomplete, getTaskDevices } = register();
    getTaskDevices.mockImplementation(() => { throw new Error('Scheduled task devices are unavailable. Try again.'); });

    await expect(autocomplete('disable_device_task_schedules', 'device')).resolves.toEqual([
      { id: 'water-heater', name: 'Device details unavailable · water-heater' },
    ]);
  });

  it('rejects missing selections and preserves owner read/write errors', async () => {
    const { run, lookup, write } = register();
    await expect(run('enable_schedule')).rejects.toThrow('Select a schedule');
    await expect(run('disable_device_task_schedules', { device: {} })).rejects.toThrow('Select a device');

    lookup.mockImplementation(() => { throw new Error('Schedules are unavailable. Try again.'); });
    await expect(run('enable_schedule', { schedule: 'night-mode' })).rejects.toThrow('Schedules are unavailable');
    write.mockImplementation(() => { throw new Error('Schedules could not be saved. Try again.'); });
    await expect(run('enable_mode_schedules')).rejects.toThrow('could not be saved');
  });

  it('selects and checks mode schedules alongside an unavailable task device', async () => {
    const { autocomplete, getTaskDevices, run, lookup, definitions } = register();
    getTaskDevices.mockImplementation(() => { throw new Error('Unavailable devices'); });
    await expect(autocomplete('enable_schedule', 'schedule', 'night')).resolves.toEqual([
      expect.objectContaining({ id: 'night-mode', name: 'Night mode' }),
    ]);
    await expect(run('disable_schedule', { schedule: 'night-mode' })).resolves.toBe(true);
    await expect(mockHomeyInstance.flow._conditionCardListeners.schedule_is_enabled({ schedule: 'night-mode' }))
      .resolves.toBe(true);
    expect(lookup).toHaveBeenCalledWith('night-mode');
    expect(definitions).toHaveBeenCalledTimes(1);
  });

});
