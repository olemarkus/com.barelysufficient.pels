// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createEmptyDeferredObjectiveSettings } from '../../shared-domain/src/settings/deferredObjectiveSettings.ts';
import { SETTINGS_UI_SMART_TASK_DEVICES_PATH } from '../../contracts/src/settingsUiApi.ts';

const callApiMock = vi.fn();
let settingsLoaded = true;
let createOpenFor: string | null = null;
vi.mock('../src/ui/homey.ts', () => ({
  callApi: (...args: unknown[]) => callApiMock(...args),
  getHomeyTimezone: () => 'Europe/Oslo',
}));
vi.mock('../src/ui/deferredObjectiveSettings.ts', () => ({
  hasLoadedDeferredObjectiveSettings: () => settingsLoaded,
}));
vi.mock('../src/ui/smartTaskCreate.ts', () => ({
  isSmartTaskCreateOpenFor: (deviceId: string) => deviceId === createOpenFor,
}));
const { state } = await import('../src/ui/state.ts');
const { hideDeviceSmartTaskBox, renderDeviceSmartTaskBox } = await import('../src/ui/deviceDetail/smartTaskBox.ts');

const box = (): HTMLElement => document.getElementById('device-detail-smart-task')!;
const flush = async (): Promise<void> => { await new Promise((resolve) => { setTimeout(resolve, 0); }); };

describe('device Smart task box', () => {
  beforeEach(() => {
    document.body.innerHTML = '<section id="device-detail-smart-task" hidden></section>';
    callApiMock.mockReset();
    settingsLoaded = true;
    createOpenFor = null;
    state.deferredObjectiveSettings = createEmptyDeferredObjectiveSettings();
    state.managedMap = { heater: true };
    hideDeviceSmartTaskBox();
  });

  it('stays hidden while checking, then offers Add once the candidate list includes the device', async () => {
    callApiMock.mockResolvedValue({ state: 'ready', devices: [{ deviceId: 'heater' }] });
    renderDeviceSmartTaskBox('heater');
    expect(box().hidden).toBe(true);
    await flush();
    expect(box().hidden).toBe(false);
    expect(box().querySelector('md-text-button[data-smart-task-create="heater"]')?.textContent)
      .toBe('Add smart task');
    expect(callApiMock).toHaveBeenCalledWith('GET', SETTINGS_UI_SMART_TASK_DEVICES_PATH);
  });

  it('reads the candidate list once per open, and again when Managed changes', async () => {
    callApiMock.mockResolvedValue({ state: 'ready', devices: [{ deviceId: 'heater' }] });
    renderDeviceSmartTaskBox('heater');
    await flush();
    renderDeviceSmartTaskBox('heater');
    renderDeviceSmartTaskBox('heater');
    expect(callApiMock).toHaveBeenCalledTimes(1);
    state.managedMap = { heater: false };
    renderDeviceSmartTaskBox('heater');
    await flush();
    expect(callApiMock).toHaveBeenCalledTimes(2);
    hideDeviceSmartTaskBox();
    renderDeviceSmartTaskBox('heater');
    await flush();
    expect(callApiMock).toHaveBeenCalledTimes(3);
  });

  it('hides the box for a device no task can be created on', async () => {
    callApiMock.mockResolvedValue({ state: 'ready', devices: [{ deviceId: 'other' }] });
    renderDeviceSmartTaskBox('heater');
    await flush();
    expect(box().hidden).toBe(true);
  });

  it('shows the open task from state, with a way to it, without a request', () => {
    state.deferredObjectiveSettings.objectivesByDeviceId.heater = {
      enabled: true, kind: 'temperature', enforcement: 'soft', targetTemperatureC: 65,
      deadlineAtMs: Date.now() + 3_600_000,
    };
    renderDeviceSmartTaskBox('heater');
    expect(box().textContent).toContain('Target 65 °C');
    expect(box().textContent).toContain('Ready by');
    expect(box().querySelector('md-text-button[data-smart-task-view="heater"]')?.textContent).toBe('View task');
    expect(callApiMock).not.toHaveBeenCalled();
  });

  it('offers no Add before the stored tasks have loaded, which would read as none', () => {
    settingsLoaded = false;
    renderDeviceSmartTaskBox('heater');
    expect(box().hidden).toBe(true);
    expect(callApiMock).not.toHaveBeenCalled();
  });

  it('offers no Add while the device’s first task is being created, which would restart the draft', () => {
    createOpenFor = 'heater';
    renderDeviceSmartTaskBox('heater');
    expect(box().hidden).toBe(true);
    expect(callApiMock).not.toHaveBeenCalled();
  });

  it('stays hidden when the candidate check fails', async () => {
    callApiMock.mockRejectedValue(new Error('unavailable'));
    renderDeviceSmartTaskBox('heater');
    await flush();
    expect(box().hidden).toBe(true);
    expect(box().querySelector('[data-smart-task-create]')).toBeNull();
  });
});
