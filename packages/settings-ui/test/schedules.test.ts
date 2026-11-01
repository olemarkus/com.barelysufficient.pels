// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Schedule, SchedulesSnapshot } from '../../contracts/src/schedules.ts';
import type { SmartTaskCandidateDevice } from '../../contracts/src/smartTaskEdit.ts';
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
  entries: [{ schedule: structuredClone(schedule), modeReferences: [], state: 'on', reason: '', nextAtMs: 1, nextLabel: 'Tomorrow 22:00', lastResult: '', lastLabel: '' }],
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
  it('keeps a valid task device, target and permissions when its action is selected again', async () => {
    const heater: SmartTaskCandidateDevice = {
      deviceId: 'heater', deviceName: 'Water heater', kind: 'temperature', group: 'heating',
      unitSymbol: '°C', goalMin: 30, goalMax: 75, goalStep: 0.5, defaultGoal: 65, currentValue: 40,
      supportsLimitLowerPriority: false, offersQuickTargets: false, otherGoals: [],
    };
    const entry = read.entries[0];
    if (!entry) throw new Error('Missing fixture entry');
    entry.schedule = {
      ...schedule, id: 'water', name: 'Hot water',
      action: { type: 'task', task: {
        deviceId: heater.deviceId, kind: heater.kind, target: 70, readyByLocalTime: '07:00',
        exemptFromBudget: true, limitLowerPriorityDevices: false, pauseLowerPriorityDevices: true,
      } },
    };
    callApiMock.mockImplementation(async (_method: string, path: string) => {
      if (path === SETTINGS_UI_DEVICES_PATH) return { schedules: { ok: true, data: structuredClone(read) } };
      if (path === SETTINGS_UI_SMART_TASK_DEVICES_PATH) return { state: 'ready', devices: [heater] };
      throw new Error(`Unexpected request: ${path}`);
    });
    window.history.replaceState({}, '', '/?page=settings/schedules&schedule=water');
    await controller.refreshSchedules();
    controller.changeScheduleDraft({ target: '72' });
    const expected = {
      deviceId: heater.deviceId, taskKind: heater.kind, target: '72', readyBy: '07:00', actionType: 'task',
      permissions: { exemptFromBudget: true, limitLowerPriorityDevices: false, pauseLowerPriorityDevices: true },
    };
    renders.at(-1)?.actions.onSelectAction('task');
    expect(renders.at(-1)?.snapshot.editor?.draft).toMatchObject(expected);
    renders.at(-1)?.actions.onSelectAction('mode');
    renders.at(-1)?.actions.onSelectAction('task');
    expect(renders.at(-1)?.snapshot.editor?.draft).toMatchObject(expected);
  });

  it('starts a new schedule at a free time, lets its name and time follow the action, and flags a clash at the time', async () => {
    const heater: SmartTaskCandidateDevice = {
      deviceId: 'heater', deviceName: 'Water heater', kind: 'temperature', group: 'heating',
      unitSymbol: '°C', goalMin: 30, goalMax: 75, goalStep: 0.5, defaultGoal: 65, currentValue: 40,
      supportsLimitLowerPriority: false, offersQuickTargets: false, otherGoals: [],
    };
    const original = read.entries[0];
    if (!original) throw new Error('Missing fixture entry');
    read.entries.push({ ...original, schedule: { ...schedule, id: 'evening', at: '18:00',
      repeat: { type: 'weekly', days: [1, 2, 3, 4, 5, 6, 7] },
      action: { type: 'task', task: { deviceId: heater.deviceId, kind: heater.kind, target: 65, readyByLocalTime: '07:00' } },
    } });
    callApiMock.mockImplementation(async (_method: string, path: string) => {
      if (path === SETTINGS_UI_DEVICES_PATH) return { schedules: { ok: true, data: structuredClone(read) } };
      if (path === SETTINGS_UI_SMART_TASK_DEVICES_PATH) return { state: 'ready', devices: [heater] };
      throw new Error(`Unexpected request: ${path}`);
    });
    window.history.replaceState({}, '', '/?page=settings/schedules&schedule=new');
    await controller.refreshSchedules();
    expect(renders.at(-1)?.snapshot.editor?.draft).toMatchObject({ name: 'Water heater task', at: '19:00' });

    renders.at(-1)?.actions.onSelectAction('mode');
    expect(renders.at(-1)?.snapshot.editor?.draft).toMatchObject({ name: 'Home mode', at: '23:00' });

    controller.changeScheduleDraft({ name: 'Evening heat' });
    renders.at(-1)?.actions.onSelectAction('task');
    expect(renders.at(-1)?.snapshot.editor?.draft).toMatchObject({ name: 'Evening heat', at: '19:00' });

    // An owner-set time stays put even where it equals another action's automatic time.
    controller.changeScheduleDraft({ at: '23:00' });
    renders.at(-1)?.actions.onSelectAction('mode');
    renders.at(-1)?.actions.onSelectAction('task');
    expect(renders.at(-1)?.snapshot.editor?.draft).toMatchObject({ name: 'Evening heat', at: '23:00' });

    controller.changeScheduleDraft({ at: '18:00' });
    renders.at(-1)?.actions.onSave();
    expect(renders.at(-1)?.snapshot.editor?.timeConflict).toBe(true);
    expect(renders.at(-1)?.snapshot.error).toBe('');
    expect(setSettingMock).not.toHaveBeenCalled();
    controller.changeScheduleDraft({ at: '18:30' });
    expect(renders.at(-1)?.snapshot.editor).toMatchObject({ timeConflict: false, draft: { at: '18:30' } });
  });

  it('preserves a saved battery target through candidate changes until the device is explicitly selected', async () => {
    const battery: SmartTaskCandidateDevice = {
      deviceId: 'charger', deviceName: 'Charger', kind: 'ev_soc', group: 'ev_charger',
      unitSymbol: '%', goalMin: 1, goalMax: 100, goalStep: 1, defaultGoal: 80, currentValue: 40,
      supportsLimitLowerPriority: false, offersQuickTargets: false, otherGoals: [],
    };
    const energy: SmartTaskCandidateDevice = {
      ...battery, kind: 'energy', unitSymbol: 'kWh', goalMin: 0.1, goalStep: 0.1, defaultGoal: 20,
    };
    let candidate = battery;
    read.entries[0].schedule = { ...schedule, id: 'charge', action: { type: 'task', task: {
      deviceId: battery.deviceId, kind: battery.kind, target: 80, readyByLocalTime: '07:00',
      exemptFromBudget: true,
    } } };
    callApiMock.mockImplementation(async (_method: string, path: string) => {
      if (path === SETTINGS_UI_DEVICES_PATH) return { schedules: { ok: true, data: structuredClone(read) } };
      if (path === SETTINGS_UI_SMART_TASK_DEVICES_PATH) return { state: 'ready', devices: [candidate] };
      throw new Error(`Unexpected request: ${path}`);
    });
    window.history.replaceState({}, '', '/?page=settings/schedules&schedule=charge');
    await controller.refreshSchedules();
    controller.changeScheduleDraft({ name: 'Changed name' });
    candidate = energy;
    await controller.refreshSchedules();
    renders.at(-1)?.actions.onSelectAction('task');
    expect(renders.at(-1)?.snapshot.editor?.draft).toMatchObject({
      taskKind: 'ev_soc', target: '80', permissions: { exemptFromBudget: true },
    });
    renders.at(-1)?.actions.onSave();
    await vi.waitFor(() => expect(renders.at(-1)?.snapshot.error).toContain('not available'));
    expect(setSettingMock).not.toHaveBeenCalled();

    candidate = battery;
    await controller.refreshSchedules();
    expect(renders.at(-1)?.snapshot.editor?.draft).toMatchObject({ taskKind: 'ev_soc', target: '80' });
    candidate = energy;
    await controller.refreshSchedules();
    renders.at(-1)?.actions.onDevice(energy.deviceId);
    expect(renders.at(-1)?.snapshot.editor?.draft).toMatchObject({
      taskKind: 'energy', target: '20', permissions: { exemptFromBudget: false },
    });
  });

  it('saves a retained kWh target using its supported bounds when the picker defaults to battery', async () => {
    const candidate: SmartTaskCandidateDevice = {
      deviceId: 'charger', deviceName: 'Charger', kind: 'ev_soc', group: 'ev_charger',
      unitSymbol: '%', goalMin: 1, goalMax: 100, goalStep: 1, defaultGoal: 80, currentValue: 40,
      supportsLimitLowerPriority: false, offersQuickTargets: false,
      otherGoals: [{ kind: 'energy', unitSymbol: 'kWh', goalMin: 0.1, goalMax: 200, goalStep: 0.1 }],
    };
    read.entries[0].schedule = { ...schedule, id: 'retained-energy', action: { type: 'task', task: {
      deviceId: candidate.deviceId, kind: 'energy', target: 150, readyByLocalTime: '07:00',
    } } };
    callApiMock.mockImplementation(async (_method: string, path: string) => {
      if (path === SETTINGS_UI_DEVICES_PATH) return { schedules: { ok: true, data: structuredClone(read) } };
      if (path === SETTINGS_UI_SMART_TASK_DEVICES_PATH) return { state: 'ready', devices: [candidate] };
      throw new Error(`Unexpected request: ${path}`);
    });
    setSettingMock.mockImplementation(async (_key: string, value: Schedule) => {
      read.entries[0].schedule = value;
    });
    window.history.replaceState({}, '', '/?page=settings/schedules&schedule=retained-energy');
    await controller.refreshSchedules();
    controller.changeScheduleDraft({ name: 'More energy overnight' });
    renders.at(-1)?.actions.onSave();
    await vi.waitFor(() => expect(renders.at(-1)?.snapshot.editor).toBeNull());
    expect(setSettingMock).toHaveBeenCalledWith('schedule.retained-energy', expect.objectContaining({
      name: 'More energy overnight', action: { type: 'task', task: {
        deviceId: 'charger', kind: 'energy', target: 150, readyByLocalTime: '07:00',
        exemptFromBudget: false, limitLowerPriorityDevices: false, pauseLowerPriorityDevices: false,
      } },
    }));
    expect(renders.at(-1)?.snapshot.error).toBe('');
  });

  it('allows an unavailable condition to be removed before saving its replacement', async () => {
    read.entries[0].schedule = {
      ...schedule, id: 'repair-condition', condition: { type: 'include', modes: ['Removed'] },
    };
    window.history.replaceState({}, '', '/?page=settings/schedules&schedule=repair-condition');
    await controller.refreshSchedules();
    renders.at(-1)?.actions.onConditionMode('Home');
    renders.at(-1)?.actions.onSave();
    await vi.waitFor(() => expect(renders.at(-1)?.snapshot.error).toContain('Choose the modes'));
    expect(setSettingMock).not.toHaveBeenCalled();
    renders.at(-1)?.actions.onConditionMode('Removed');
    setSettingMock.mockImplementation(async (_key: string, value: Schedule) => {
      read.entries[0].schedule = value;
    });
    renders.at(-1)?.actions.onSave();
    await vi.waitFor(() => expect(setSettingMock).toHaveBeenCalledWith('schedule.repair-condition',
      expect.objectContaining({ condition: { type: 'include', modes: ['Home'] } })));
    await vi.waitFor(() => expect(renders.at(-1)?.snapshot.busy).toBe(false));
  });

  it('does not borrow a renamed mode reference from another schedule', async () => {
    const original = read.entries[0];
    if (!original) throw new Error('Missing fixture entry');
    read.entries.push({ ...original,
      schedule: { ...schedule, id: 'renamed', action: { type: 'mode', mode: 'Old Home' } },
      modeReferences: [{ stored: 'Old Home', resolved: 'Home' }],
    });
    window.history.replaceState({}, '', '/?page=settings/schedules&schedule=night');
    await controller.refreshSchedules();
    controller.changeScheduleDraft({ mode: 'Old Home' });
    renders.at(-1)?.actions.onSave();
    await vi.waitFor(() => expect(renders.at(-1)?.snapshot.error).toBe('Choose an available mode.'));
    expect(setSettingMock).not.toHaveBeenCalled();
  });

  it('opens a device link on that device after an unsaved draft for another device', async () => {
    const device = (deviceId: string, deviceName: string): SmartTaskCandidateDevice => ({
      deviceId, deviceName, kind: 'temperature', group: 'heating', unitSymbol: '°C', goalMin: 30, goalMax: 75,
      goalStep: 0.5, defaultGoal: 65, currentValue: 40, supportsLimitLowerPriority: false,
      offersQuickTargets: false, otherGoals: [],
    });
    callApiMock.mockImplementation(async (_method: string, path: string) => {
      if (path === SETTINGS_UI_DEVICES_PATH) return { schedules: { ok: true, data: structuredClone(read) } };
      if (path === SETTINGS_UI_SMART_TASK_DEVICES_PATH) {
        return { state: 'ready', devices: [device('tank', 'Water heater'), device('floor', 'Bathroom floor')] };
      }
      throw new Error(`Unexpected request: ${path}`);
    });
    controller.initSchedulesNavigation(() => {}, () => {});
    const link = (deviceId: string): HTMLElement => {
      const anchor = document.createElement('a');
      anchor.dataset.openSchedules = '';
      anchor.dataset.scheduleDevice = deviceId;
      document.body.append(anchor);
      return anchor;
    };
    await controller.refreshSchedules();
    link('tank').click();
    expect(renders.at(-1)?.snapshot.editor?.draft.deviceId).toBe('tank');
    // Leaving through the shell navigation drops the route but not the unsaved draft.
    window.history.replaceState({}, '', '/?page=overview');
    link('floor').click();
    expect(renders.at(-1)?.snapshot.editor?.draft).toMatchObject({ deviceId: 'floor', name: 'Bathroom floor task' });
    controller.backFromScheduleEditor();
  });

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
