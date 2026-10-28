// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Schedule, SchedulesSnapshot } from '../../contracts/src/schedules.ts';
import type { SchedulesViewSnapshot } from '../src/ui/schedulesTypes.ts';
import type { SchedulesActions } from '../src/ui/views/Schedules.tsx';
import { SETTINGS_UI_DEVICES_PATH, SETTINGS_UI_SMART_TASK_DEVICES_PATH } from '../../contracts/src/settingsUi/paths.ts';

const callApiMock = vi.fn();
const setSettingMock = vi.fn();
vi.mock('../src/ui/homey.ts', () => ({
  callApi: (...args: unknown[]) => callApiMock(...args),
  setSetting: (...args: unknown[]) => setSettingMock(...args),
}));
const renders: { snapshot: SchedulesViewSnapshot; actions: SchedulesActions }[] = [];
vi.mock('../src/ui/views/Schedules.tsx', () => ({
  renderSchedules: (_root: HTMLElement, snapshot: SchedulesViewSnapshot, actions: SchedulesActions) => {
    renders.push({ snapshot, actions });
  },
}));
vi.mock('../src/ui/state.ts', () => ({ state: { activePanel: 'schedules' } }));
const controller = await import('../src/ui/schedules.ts');
const schedule: Schedule = {
  id: 'night', name: 'Night mode', enabled: true, at: '22:00',
  repeat: { type: 'weekly', days: [1, 2, 3, 4, 5] }, condition: { type: 'any' },
  action: { type: 'mode', mode: 'Night' },
};
const ownerRead = (): SchedulesSnapshot => ({
  timeZone: 'Europe/Oslo', modes: ['Home', 'Night'],
  controls: { modeChangesEnabled: true, disabledTaskDeviceIds: [] },
  entries: [{ schedule: structuredClone(schedule), state: 'on', reason: '', nextAtMs: 1, nextLabel: 'Tomorrow 22:00', lastResult: '' }],
});
let read = ownerRead();

beforeEach(() => {
  document.body.innerHTML = '<div id="schedules-root"></div>';
  window.history.replaceState(null, '', '/?page=settings/schedules');
  callApiMock.mockReset();
  setSettingMock.mockReset();
  setSettingMock.mockResolvedValue(undefined);
  renders.length = 0;
  read = ownerRead();
  callApiMock.mockImplementation(async (_method: string, path: string) => {
    if (path === SETTINGS_UI_DEVICES_PATH) return { schedules: { ok: true, data: structuredClone(read) } };
    if (path === SETTINGS_UI_SMART_TASK_DEVICES_PATH) return { state: 'ready', devices: [] };
    throw new Error(`Unexpected request: ${path}`);
  });
});

describe('Schedule settings bridge', () => {
  it('does not turn an unavailable device deep link into an unrelated mode schedule', async () => {
    window.history.replaceState({}, '', '/?page=settings/schedules&schedule=new&scheduleDevice=missing');
    await controller.refreshSchedules();
    expect(renders.at(-1)?.snapshot).toMatchObject({
      load: 'ready', editor: null, error: 'This device is not available for a scheduled Smart task.',
    });
  });

  it('rejects an owner acknowledgement that still carries the previous definition', async () => {
    await expect(controller.persistScheduleCommand({
      type: 'save', schedule: { ...schedule, name: 'Changed name' },
    }, read)).rejects.toThrow('could not be confirmed');
  });
  it('refuses a new schedule beyond the shared limit before writing settings', async () => {
    const full = ownerRead();
    const entry = full.entries[0];
    if (!entry) throw new Error('Missing fixture entry');
    full.entries = Array.from({ length: 100 }, (_, index) => ({
      ...entry, schedule: { ...schedule, id: `saved-${index}` },
    }));
    await expect(controller.persistScheduleCommand({ type: 'save', schedule }, full)).rejects.toThrow('at most');
    expect(setSettingMock).not.toHaveBeenCalled();
  });
  it('keeps mode schedules usable when Smart-task device data is unavailable', async () => {
    callApiMock.mockImplementation(async (_method: string, path: string) => {
      if (path === SETTINGS_UI_DEVICES_PATH) return { schedules: { ok: true, data: structuredClone(read) } };
      throw new Error('Device read failed');
    });
    await controller.refreshSchedules();
    expect(renders.at(-1)?.snapshot).toMatchObject({ load: 'ready', read, devices: [] });
  });

  it('uses only the selected schedule key and waits for owner confirmation', async () => {
    const changed = { ...schedule, name: 'Late night' };
    read.entries[0].schedule = changed;
    await controller.persistScheduleCommand({ type: 'save', schedule: changed }, read);
    expect(setSettingMock).toHaveBeenCalledWith('schedule.night', changed);
    expect(callApiMock).toHaveBeenCalledWith('GET', SETTINGS_UI_DEVICES_PATH);
  });

  it('does not call the settings bridge for a past or nonexistent one-off clock time', async () => {
    const once = { ...schedule, repeat: { type: 'once' as const, date: '2026-03-29' }, at: '02:30' };
    await expect(controller.persistScheduleCommand({ type: 'save', schedule: once }, read)).rejects.toThrow('Choose a future date and time');
    expect(setSettingMock).not.toHaveBeenCalled();
  });

  it('group switches leave individual schedule settings untouched', async () => {
    read.controls.modeChangesEnabled = false;
    const result = await controller.persistScheduleCommand({ type: 'set_mode_schedules_enabled', enabled: false }, ownerRead());
    expect(setSettingMock.mock.calls).toEqual([['schedule_modes_enabled', false]]);
    expect(result.entries[0].schedule.enabled).toBe(true);
  });

  it('reports a failed owner read rather than a successful empty list', async () => {
    callApiMock.mockResolvedValue({ schedules: { ok: false, error: 'Stored schedules unavailable.' } });
    await expect(controller.readSchedules()).rejects.toThrow('Stored schedules unavailable.');
  });

  it('keeps a failed save open and serializes repeated switch actions', async () => {
    await controller.refreshSchedules();
    let finish: () => void = () => {};
    setSettingMock.mockReturnValueOnce(new Promise<void>((resolve) => { finish = resolve; }));
    const actions = renders.at(-1)?.actions;
    expect(actions).toBeDefined();
    actions?.onModeGroup(false);
    actions?.onModeGroup(false);
    expect(setSettingMock).toHaveBeenCalledTimes(1);
    finish();
    await vi.waitFor(() => expect(renders.at(-1)?.snapshot.busy).toBe(false));
    expect(renders.at(-1)?.snapshot.error).toContain('could not be confirmed');
    expect(renders.at(-1)?.snapshot.read?.controls.modeChangesEnabled).toBe(true);
  });
});
