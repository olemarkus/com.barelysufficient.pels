// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  SETTINGS_UI_SMART_TASK_CREATE_PATH,
  SETTINGS_UI_SMART_TASK_CREATE_PREVIEW_PATH,
  SETTINGS_UI_SMART_TASK_DEVICES_PATH,
} from '../../contracts/src/settingsUiApi.ts';
import type { SmartTaskCandidateDevice } from '../../contracts/src/smartTaskEdit.ts';
import { createEmptyDeferredObjectiveSettings } from '../../shared-domain/src/settings/deferredObjectiveSettings.ts';

const callApiMock = vi.fn();
vi.mock('../src/ui/homey.ts', () => ({
  callApi: (...args: unknown[]) => callApiMock(...args),
  getHomeyTimezone: () => 'Europe/Oslo',
}));
let storedTasksLoaded = true;
const loadStoredTasksMock = vi.fn(async () => { storedTasksLoaded = true; });
vi.mock('../src/ui/deferredObjectiveSettings.ts', () => ({
  hasLoadedDeferredObjectiveSettings: () => storedTasksLoaded,
  loadDeferredObjectiveSettings: () => loadStoredTasksMock(),
}));
vi.mock('../src/ui/planSurfaceRefresh.ts', () => ({ refreshPlanSurface: vi.fn() }));
vi.mock('../src/ui/logging.ts', () => ({ logSettingsError: vi.fn(async () => undefined) }));

const { state } = await import('../src/ui/state.ts');
const controller = await import('../src/ui/smartTaskCreate.ts');

const HEATER: SmartTaskCandidateDevice = {
  deviceId: 'heater',
  deviceName: 'Water heater',
  kind: 'temperature',
  unitSymbol: '°C',
  goalMin: 30,
  goalMax: 75,
  goalStep: 0.5,
  defaultGoal: 65,
  currentValue: 52,
  supportsLimitLowerPriority: false,
  offersQuickTargets: true,
};

const PREVIEW = {
  ok: true,
  deadlineAtMs: Date.UTC(2026, 9, 13, 5, 0, 0),
  deadlineLabel: 'Tomorrow 07:00',
  scheduledWindowLabel: '02:00–04:00',
  estimate: { status: 'on_track', budgetRole: 'none', costEstimate: null, costUnit: null },
};

const flush = async (): Promise<void> => { await new Promise((resolve) => { setTimeout(resolve, 0); }); };

const navigatedTo: string[] = [];
const recordNavigation = (event: MouseEvent): void => {
  const anchor = (event.target as Element | null)?.closest('a');
  if (!anchor) return;
  event.preventDefault();
  navigatedTo.push(anchor.getAttribute('href') ?? '');
};

const paints: Array<ReturnType<typeof controller.getSmartTaskCreateSnapshot>> = [];
const openPanel = vi.fn();

const answer = (byPath: Record<string, unknown>): void => {
  callApiMock.mockImplementation(async (_method: string, path: string) => {
    if (!(path in byPath)) throw new Error(`unexpected ${path}`);
    return byPath[path];
  });
};

const step = () => controller.getSmartTaskCreateSnapshot()?.step;

describe('New smart task flow', () => {
  beforeEach(() => {
    document.body.innerHTML = `
      <div id="deadlines-list-root"></div>
      <div id="deadlines-history-root"></div>
      <div id="smart-task-create-root" hidden></div>`;
    callApiMock.mockReset();
    navigatedTo.length = 0;
    paints.length = 0;
    openPanel.mockReset();
    storedTasksLoaded = true;
    loadStoredTasksMock.mockClear();
    state.deferredObjectiveSettings = createEmptyDeferredObjectiveSettings();
    state.devicesLoaded = true;
    controller.registerSmartTaskCreateRenderer((snapshot) => { paints.push(snapshot); });
    controller.initSmartTaskCreateController(openPanel);
    document.addEventListener('click', recordNavigation, true);
  });

  afterEach(() => {
    document.removeEventListener('click', recordNavigation, true);
  });

  it('lists the devices from the Smart tasks page and composes with the device’s default goal', async () => {
    answer({ [SETTINGS_UI_SMART_TASK_DEVICES_PATH]: { state: 'ready', devices: [HEATER] } });
    controller.openSmartTaskCreate({ kind: 'smart_tasks' });
    expect(step()?.kind).toBe('loading');
    await flush();
    expect(step()).toMatchObject({ kind: 'pick', devices: [HEATER] });
    controller.selectSmartTaskCreateDevice('heater');
    expect(step()).toMatchObject({ kind: 'compose', device: HEATER, draft: { goal: '65', readyBy: '07:00' } });
  });

  it('loads the stored tasks a failed boot load left out before offering a create', async () => {
    storedTasksLoaded = false;
    answer({ [SETTINGS_UI_SMART_TASK_DEVICES_PATH]: { state: 'ready', devices: [HEATER] } });
    controller.openSmartTaskCreate({ kind: 'smart_tasks' });
    await flush();
    expect(loadStoredTasksMock).toHaveBeenCalledTimes(1);
    expect(step()?.kind).toBe('pick');
  });

  it('marks a device with an open task in the picker, and says the flow is open for the composed device', async () => {
    state.deferredObjectiveSettings.objectivesByDeviceId.heater = {
      enabled: false, kind: 'temperature', enforcement: 'soft', targetTemperatureC: 60,
      deadlineAtMs: Date.now() + 3_600_000,
    };
    answer({ [SETTINGS_UI_SMART_TASK_DEVICES_PATH]: { state: 'ready', devices: [HEATER] } });
    controller.openSmartTaskCreate({ kind: 'smart_tasks' });
    await flush();
    const current = step();
    expect(current?.kind === 'pick' && current.openTaskDeviceIds.has('heater')).toBe(true);
    expect(controller.isSmartTaskCreateOpenFor('heater')).toBe(false);
    delete state.deferredObjectiveSettings.objectivesByDeviceId.heater;
    controller.selectSmartTaskCreateDevice('heater');
    state.activePanel = 'deadlines';
    expect(controller.isSmartTaskCreateOpenFor('heater')).toBe(true);
    // A tab switch leaves the draft, but a device page opened elsewhere is not
    // one opened over the flow.
    state.activePanel = 'devices';
    expect(controller.isSmartTaskCreateOpenFor('heater')).toBe(false);
  });

  it('sends a device that already has an open task to that task instead', async () => {
    state.deferredObjectiveSettings.objectivesByDeviceId.heater = {
      enabled: true, kind: 'temperature', enforcement: 'soft', targetTemperatureC: 60,
      deadlineAtMs: Date.now() + 3_600_000,
    };
    answer({ [SETTINGS_UI_SMART_TASK_DEVICES_PATH]: { state: 'ready', devices: [HEATER] } });
    controller.openSmartTaskCreate({ kind: 'device', deviceId: 'heater', sourceTab: 'devices' });
    await flush();
    expect(controller.getSmartTaskCreateSnapshot()).toBeNull();
    expect(paints.at(-1)).toBeNull();
    expect(navigatedTo).toEqual(['./?page=deadline-plan&deviceId=heater&edit=1']);
  });

  it('refuses to preview a goal outside the device’s range, without a request', async () => {
    answer({ [SETTINGS_UI_SMART_TASK_DEVICES_PATH]: { state: 'ready', devices: [HEATER] } });
    controller.openSmartTaskCreate({ kind: 'device', deviceId: 'heater', sourceTab: 'devices' });
    await flush();
    controller.setSmartTaskCreateGoal('90');
    await controller.requestSmartTaskCreatePreview();
    expect(controller.getSmartTaskCreateSnapshot()?.errorLine).toBe('Enter a goal within this device’s range.');
    expect(callApiMock).toHaveBeenCalledTimes(1);
  });

  it('creates the task for the deadline the preview showed and opens it', async () => {
    answer({
      [SETTINGS_UI_SMART_TASK_DEVICES_PATH]: { state: 'ready', devices: [HEATER] },
      [SETTINGS_UI_SMART_TASK_CREATE_PREVIEW_PATH]: PREVIEW,
      [SETTINGS_UI_SMART_TASK_CREATE_PATH]: { ok: true },
    });
    controller.openSmartTaskCreate({ kind: 'device', deviceId: 'heater', sourceTab: 'devices' });
    await flush();
    controller.setSmartTaskCreatePermission('exemptFromBudget', true);
    await controller.requestSmartTaskCreatePreview();
    expect(step()?.kind).toBe('preview');
    await controller.submitSmartTaskCreate();
    expect(callApiMock).toHaveBeenLastCalledWith('POST', SETTINGS_UI_SMART_TASK_CREATE_PATH, {
      deviceId: 'heater',
      kind: 'temperature',
      target: 65,
      readyByLocalTime: '07:00',
      exemptFromBudget: true,
      limitLowerPriorityDevices: false,
      pauseLowerPriorityDevices: false,
      deadlineAtMs: PREVIEW.deadlineAtMs,
    });
    expect(controller.getSmartTaskCreateSnapshot()).toBeNull();
    expect(navigatedTo).toEqual(['./?page=deadline-plan&deviceId=heater']);
  });

  it('returns to the device page it was opened from', async () => {
    answer({ [SETTINGS_UI_SMART_TASK_DEVICES_PATH]: { state: 'ready', devices: [HEATER] } });
    const opened = vi.fn();
    document.addEventListener('open-device-detail', opened);
    controller.openSmartTaskCreate({ kind: 'device', deviceId: 'heater', sourceTab: 'devices' });
    await flush();
    controller.backFromSmartTaskCreate();
    expect(openPanel).toHaveBeenCalledWith('devices');
    expect((opened.mock.calls[0]?.[0] as CustomEvent).detail).toEqual({ deviceId: 'heater', focus: 'top' });
    document.removeEventListener('open-device-detail', opened);
  });

  it('opens the device page over the flow on Change, and repaints when it closes', async () => {
    answer({ [SETTINGS_UI_SMART_TASK_DEVICES_PATH]: { state: 'ready', devices: [HEATER] } });
    const opened = vi.fn();
    document.addEventListener('open-device-detail', opened);
    controller.openSmartTaskCreate({ kind: 'device', deviceId: 'heater', sourceTab: 'devices' });
    await flush();
    controller.openSmartTaskCreateDeviceSettings();
    expect((opened.mock.calls[0]?.[0] as CustomEvent).detail).toEqual({ deviceId: 'heater', focus: 'power-limit' });
    const before = paints.length;
    document.dispatchEvent(new CustomEvent('device-detail-closed'));
    expect(paints.length).toBe(before + 1);
    expect(step()?.kind).toBe('compose');
    document.removeEventListener('open-device-detail', opened);
  });
});
