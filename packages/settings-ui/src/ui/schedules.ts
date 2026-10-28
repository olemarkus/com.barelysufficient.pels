import type {
  ScheduleCommand, SchedulesSnapshot,
} from '../../../contracts/src/schedules.ts';
import { SETTINGS_UI_SMART_TASK_DEVICES_PATH } from '../../../contracts/src/settingsUi/paths.ts';
import type {
  SettingsUiSmartTaskDevicesResponse, SmartTaskCandidateDevice,
} from '../../../contracts/src/smartTaskEdit.ts';
import { isUnknownRecord } from '../../../shared-domain/src/recordGuards.ts';
import { callApi } from './homey.ts';
import { persistScheduleCommand, readSchedules } from './schedulesTransport.ts';
export { persistScheduleCommand, readSchedules } from './schedulesTransport.ts';
import { state } from './state.ts';
import {
  buildScheduleFromDraft, createScheduleDraft, daysForRepeat, editScheduleDraft,
  type ScheduleDraft, type ScheduleRepeatChoice,
} from './scheduleDraft.ts';
import { renderSchedules } from './views/Schedules.tsx';

import type { SchedulesViewSnapshot } from './schedulesTypes.ts';

let view: SchedulesViewSnapshot = {
  load: 'loading', read: null, devices: [], busy: false, error: '', editor: null, filter: 'all',
};
let generation = 0;
let openPanel: (panel: string) => void = () => {};
let closeDevice: () => void = () => {};
const SCHEDULE_PARAM = 'schedule';
const DEVICE_PARAM = 'scheduleDevice';
const FILTER_PARAM = 'scheduleFilter';

const paint = (): void => {
  const root = document.getElementById('schedules-root');
  if (root) renderSchedules(root, view, {
    onRetry: () => { void refreshSchedules(); },
    onNew: () => openScheduleEditor('new'),
    onEdit: openScheduleEditor,
    onBack: backFromScheduleEditor,
    onDraftChange: changeScheduleDraft,
    onSelectAction: selectScheduleAction,
    onDevice: selectScheduleDevice,
    onRepeat: changeScheduleRepeat,
    onDay: toggleScheduleDay,
    onConditionMode: toggleScheduleConditionMode,
    onSave: () => { void saveScheduleDraft(); },
    onDelete: () => { void deleteScheduleDraft(); },
    onToggle: (id, enabled) => { void writeCommand({ type: 'set_enabled', id, enabled }); },
    onModeGroup: (enabled) => { void writeCommand({ type: 'set_mode_schedules_enabled', enabled }); },
    onDeviceGroup: (deviceId, enabled) => {
      void writeCommand({ type: 'set_device_schedules_enabled', deviceId, enabled });
    },
    onFilter: setScheduleFilter,
  });
};

const localToday = (timeZone: string): string => {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(Date.now()).map((part) => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
};

const newScheduleDevice = (params: URLSearchParams): SmartTaskCandidateDevice | undefined => {
  const deviceId = params.get(DEVICE_PARAM);
  if (deviceId) return view.devices.find((candidate) => candidate.deviceId === deviceId);
  if (view.filter === 'mode') return undefined;
  return view.devices[0];
};

const hydrateEditor = (id: string, read: SchedulesSnapshot, params: URLSearchParams): void => {
  const today = localToday(read.timeZone);
  if (id === 'new') {
    const device = newScheduleDevice(params);
    const requested = params.get(DEVICE_PARAM);
    if (requested !== null && device?.deviceId !== requested) {
      view = { ...view, editor: null, error: 'This device is not available for a scheduled Smart task.' };
      return;
    }
    view = { ...view, editor: {
      kind: 'new', draft: createScheduleDraft(device, read.modes[0] ?? '', today),
    } };
    return;
  }
  const schedule = read.entries.find((entry) => entry.schedule.id === id)?.schedule;
  if (!schedule) {
    view = { ...view, editor: null, error: 'This schedule no longer exists. Its saved tasks are unchanged.' };
    return;
  }
  view = { ...view, editor: { kind: 'existing', draft: editScheduleDraft(schedule, today) } };
};

const updateEditorFromRoute = (): void => {
  const params = new URLSearchParams(window.location.search);
  const filter = params.get(FILTER_PARAM);
  view = { ...view, filter: filter === 'mode' || filter === 'task' ? filter : 'all' };
  const id = params.get(SCHEDULE_PARAM);
  if (!id) { view = { ...view, editor: null }; return; }
  if (!view.read || view.load !== 'ready') return;
  if (view.editor?.draft.id === id) return;
  if (id === 'new' && view.editor?.kind === 'new') return;
  hydrateEditor(id, view.read, params);
};

export const refreshSchedules = async (): Promise<void> => {
  if (view.busy) return;
  const current = ++generation;
  view = { ...view, load: view.read ? view.load : 'loading', error: '' };
  paint();
  try {
    const [read, candidates] = await Promise.all([
      readSchedules(), callApi<SettingsUiSmartTaskDevicesResponse>('GET', SETTINGS_UI_SMART_TASK_DEVICES_PATH)
        .catch((): SettingsUiSmartTaskDevicesResponse => ({ state: 'unavailable' })),
    ]);
    if (current !== generation) return;
    view = { ...view, load: 'ready', read,
      devices: candidates.state === 'ready' ? candidates.devices : [],
      error: candidates.state === 'ready' ? ''
        : 'Smart-task devices are temporarily unavailable. Mode schedules can still be used.',
    };
    updateEditorFromRoute();
  } catch {
    if (current !== generation) return;
    view = { ...view, load: 'error', error: 'Schedules could not be refreshed. Refresh before making changes.' };
  }
  paint();
};

const writeCommand = async (command: ScheduleCommand): Promise<boolean> => {
  if (view.busy || view.load !== 'ready' || !view.read) return false;
  const currentRead = view.read;
  generation += 1;
  view = { ...view, busy: true, error: '' };
  paint();
  try {
    const read = await persistScheduleCommand(command, currentRead);
    view = { ...view, read, busy: false, error: '' };
    paint();
    return true;
  } catch (error) {
    view = {
      ...view, busy: false,
      error: `${error instanceof Error ? error.message : 'The change could not be saved.'} `
        + 'Refresh to check the current state.',
    };
    paint();
    return false;
  }
};

const readHistoryState = (): Record<string, unknown> => {
  const value: unknown = window.history.state;
  return isUnknownRecord(value) ? value : {};
};

export const openScheduleEditor = (id: string): void => {
  if (view.busy) return;
  const params = new URLSearchParams(window.location.search);
  params.set(SCHEDULE_PARAM, id);
  window.history.pushState({ ...readHistoryState(), pelsScheduleEditor: true }, '',
    `${window.location.pathname}?${params}${window.location.hash}`);
  view = { ...view, error: '', editor: null };
  updateEditorFromRoute();
  paint();
  document.getElementById('schedule-editor-heading')?.focus();
};

export const backFromScheduleEditor = (): void => {
  if (view.busy) return;
  if (readHistoryState().pelsScheduleEditor === true) { window.history.back(); return; }
  const params = new URLSearchParams(window.location.search);
  params.delete(SCHEDULE_PARAM);
  params.delete(DEVICE_PARAM);
  window.history.replaceState(window.history.state, '', `${window.location.pathname}?${params}${window.location.hash}`);
  view = { ...view, editor: null, error: '' };
  paint();
};

export const changeScheduleDraft = (patch: Partial<ScheduleDraft>): void => {
  if (!view.editor || view.busy) return;
  view = { ...view, editor: { ...view.editor, draft: { ...view.editor.draft, ...patch } }, error: '' };
  paint();
};
const selectScheduleAction = (actionType: 'mode' | 'task'): void => {
  if (!view.editor || !view.read) return;
  const draft = view.editor.draft;
  const device = view.devices.find((candidate) => candidate.deviceId === draft.deviceId) ?? view.devices[0];
  if (actionType === 'task' && device) selectScheduleDevice(device.deviceId);
  changeScheduleDraft({ actionType, mode: draft.mode || view.read.modes[0] || '' });
};
const selectScheduleDevice = (deviceId: string): void => {
  const device = view.devices.find((candidate) => candidate.deviceId === deviceId);
  if (!device) return;
  changeScheduleDraft({
    deviceId, target: String(device.defaultGoal),
    permissions: { exemptFromBudget: false, limitLowerPriorityDevices: false, pauseLowerPriorityDevices: false },
  });
};
const changeScheduleRepeat = (repeat: ScheduleRepeatChoice): void => {
  const days = repeat === 'custom' || repeat === 'once' ? {} : { days: daysForRepeat(repeat) };
  changeScheduleDraft({ repeat, ...days });
};
const toggleScheduleDay = (day: number): void => {
  const days = view.editor?.draft.days;
  if (!days) return;
  const selected = days.includes(day) ? days.filter((value) => value !== day) : [...days, day].sort();
  changeScheduleDraft({ days: selected });
};
const toggleScheduleConditionMode = (mode: string): void => {
  const modes = view.editor?.draft.conditionModes;
  if (modes) changeScheduleDraft({
    conditionModes: modes.includes(mode) ? modes.filter((value) => value !== mode) : [...modes, mode],
  });
};
const saveScheduleDraft = async (): Promise<void> => {
  if (!view.editor || !view.read || view.busy) return;
  const result = buildScheduleFromDraft(view.editor.draft, view.devices, view.read.modes);
  if (!result.ok) { view = { ...view, error: result.error }; paint(); return; }
  if (await writeCommand({ type: 'save', schedule: result.schedule })) backFromScheduleEditor();
};
const deleteScheduleDraft = async (): Promise<void> => {
  if (!view.editor || view.editor.kind !== 'existing' || view.busy) return;
  if (await writeCommand({ type: 'delete', id: view.editor.draft.id })) backFromScheduleEditor();
};
const setScheduleFilter = (filter: 'all' | 'mode' | 'task'): void => {
  const params = new URLSearchParams(window.location.search);
  if (filter === 'all') params.delete(FILTER_PARAM); else params.set(FILTER_PARAM, filter);
  window.history.replaceState(window.history.state, '', `${window.location.pathname}?${params}${window.location.hash}`);
  view = { ...view, filter };
  paint();
};

/** Reuse the shell's bounded freshness cadence; no second timer and no draft reset. */
export const refreshSchedulesIfVisible = (): void => {
  if (state.activePanel === 'schedules' && !view.busy) void refreshSchedules();
};

export const notifySchedulesSettingChanged = (key: string): void => {
  if ((key.startsWith('schedule.') || key.startsWith('schedule_task_enabled.') || key === 'schedule_modes_enabled')
    && state.activePanel === 'schedules' && !view.busy) void refreshSchedules();
};

export const initSchedulesNavigation = (showPanel: (panel: string) => void, closeDetail: () => void): void => {
  openPanel = showPanel;
  closeDevice = closeDetail;
  document.addEventListener('click', (event) => {
    const target = event.target instanceof Element
      ? event.target.closest<HTMLElement>('[data-open-schedules]') : null;
    if (!target) return;
    event.preventDefault();
    closeDevice();
    openPanel('schedules');
    const params = new URLSearchParams(window.location.search);
    if (target.dataset.scheduleFilter) params.set(FILTER_PARAM, target.dataset.scheduleFilter);
    if (target.dataset.scheduleDevice) params.set(DEVICE_PARAM, target.dataset.scheduleDevice);
    if (target.dataset.scheduleId) params.set(SCHEDULE_PARAM, target.dataset.scheduleId);
    else if (target.dataset.scheduleDevice) params.set(SCHEDULE_PARAM, 'new');
    window.history.replaceState(
      window.history.state, '', `${window.location.pathname}?${params}${window.location.hash}`,
    );
    updateEditorFromRoute();
    paint();
  });
  window.addEventListener('popstate', () => {
    if (new URLSearchParams(window.location.search).get('page') !== 'settings/schedules') return;
    updateEditorFromRoute();
    paint();
  });
};
