import { buildHomeyApiMock, installedHomeyMock } from './helpers/homeyApiMock';
import {
  buildDom,
  flushPromises,
  getDiagnosticsMetricValue,
  installSettingsHomeyMock,
  loadDeviceAndModeSettings,
  releasePageResourcesAfterEachTest,
  waitFor,
} from './helpers/settingsPage.ts';

vi.mock('../src/ui/toast.ts', () => ({
  showToast: vi.fn().mockResolvedValue(undefined),
  showToastError: vi.fn().mockResolvedValue(undefined),
}));

releasePageResourcesAfterEachTest();

describe('settings script: devices, modes and diagnostics', () => {
  beforeEach(() => {
    vi.resetModules();
    buildDom();
    window.localStorage.clear();
    installSettingsHomeyMock();
  });

  it('shows empty state when no devices support target temperature', async () => {
    installSettingsHomeyMock({ target_devices_snapshot: [] });
    installedHomeyMock().set = vi.fn((key, val, cb) => cb && cb(null));
    await loadDeviceAndModeSettings();

    expect(document.querySelectorAll('#device-card-list .pels-device-card__row').length).toBe(0);
    expect(document.querySelector('#empty-state')?.hasAttribute('hidden')).toBe(false);
  });

  it('allows toggling managed and capacity control for a socket device', async () => {
    const setSpy = vi.fn((key, val, cb) => cb && cb(null));
    installSettingsHomeyMock({
      target_devices_snapshot: [
        {
          id: 'socket-1',
          name: 'Kitchen Socket',
          deviceClass: 'socket',
          deviceType: 'onoff',
          targets: [],
          powerCapable: true,
          expectedPowerKw: 0.125,
        },
      ],
    });
    installedHomeyMock().set = setSpy;

    await loadDeviceAndModeSettings();

    const getToggles = () => {
      const buttons = Array.from(
        document.querySelectorAll('[data-device-id="socket-1"] .pels-icon-toggle'),
      ) as HTMLElement[];
      return {
        managed: buttons[0],
        controllable: buttons[1],
      };
    };

    await waitFor(() => Boolean(getToggles().managed && getToggles().controllable));
    expect(getToggles().managed.getAttribute('aria-disabled')).not.toBe('true');
    expect(getToggles().controllable.getAttribute('aria-disabled')).toBe('true');

    getToggles().managed.click();
    await waitFor(() => {
      const calls = setSpy.mock.calls.filter((call) => call[0] === 'managed_devices');
      return calls.length > 0;
    }, 1500);
    const managedCalls = setSpy.mock.calls.filter((call) => call[0] === 'managed_devices');
    expect(managedCalls[managedCalls.length - 1]?.[1]).toEqual(expect.objectContaining({ 'socket-1': true }));

    // Turning Managed on turns Limit on with it: no second tap.
    const controllableWrites = () => setSpy.mock.calls.filter((call) => call[0] === 'controllable_devices');
    await waitFor(() => controllableWrites().length > 0, 1500);
    expect(controllableWrites().at(-1)?.[1]).toEqual(expect.objectContaining({ 'socket-1': true }));

    // The toggle is the opt-out, for a device PELS should plan around but not lower.
    await waitFor(() => getToggles().controllable.getAttribute('aria-disabled') !== 'true');
    const writesBeforeOptOut = controllableWrites().length;
    getToggles().controllable.click();
    await waitFor(() => controllableWrites().length > writesBeforeOptOut, 1500);
    expect(controllableWrites().at(-1)?.[1]).toEqual(expect.objectContaining({ 'socket-1': false }));
  });

  it('allows toggling managed and capacity control for an off socket with Homey energy metadata', async () => {
    const setSpy = vi.fn((key, val, cb) => cb && cb(null));
    installSettingsHomeyMock({
      target_devices_snapshot: [
        {
          available: true,
          id: 'socket-2',
          name: 'Hall Socket',
          deviceClass: 'socket',
          deviceType: 'onoff',
          targets: [],
          binaryControl: { on: false },
          powerCapable: true,
          expectedPowerSource: 'default',
          expectedPowerKw: 1,
        },
      ],
    });
    installedHomeyMock().set = setSpy;

    await loadDeviceAndModeSettings();

    const getToggles = () => {
      const buttons = Array.from(
        document.querySelectorAll('[data-device-id="socket-2"] .pels-icon-toggle'),
      ) as HTMLElement[];
      return {
        managed: buttons[0],
        controllable: buttons[1],
      };
    };

    await waitFor(() => Boolean(getToggles().managed && getToggles().controllable));
    expect(getToggles().managed.getAttribute('aria-disabled')).not.toBe('true');
    expect(getToggles().controllable.getAttribute('aria-disabled')).toBe('true');

    getToggles().managed.click();
    await waitFor(() => {
      const calls = setSpy.mock.calls.filter((call) => call[0] === 'managed_devices');
      return calls.length > 0;
    }, 1500);
    // Turning Managed on turns Limit on with it: no second tap.
    const controllableWrites = () => setSpy.mock.calls.filter((call) => call[0] === 'controllable_devices');
    await waitFor(() => controllableWrites().length > 0, 1500);
    expect(controllableWrites().at(-1)?.[1]).toEqual(expect.objectContaining({ 'socket-2': true }));

    // The toggle is the opt-out, for a device PELS should plan around but not lower.
    await waitFor(() => getToggles().controllable.getAttribute('aria-disabled') !== 'true');
    const writesBeforeOptOut = controllableWrites().length;
    getToggles().controllable.click();
    await waitFor(() => controllableWrites().length > writesBeforeOptOut, 1500);
    expect(controllableWrites().at(-1)?.[1]).toEqual(expect.objectContaining({ 'socket-2': false }));
  });

  it('lists a thermostat without power support in Modes, since PELS still sets its mode target', async () => {
    installSettingsHomeyMock({
      target_devices_snapshot: [
        {
          id: 'unmetered',
          name: 'Thermostat without power readings',
          powerCapable: false,
          targets: [{ id: 'target_temperature', value: 21, unit: '°C' }],
        },
        {
          id: 'supported',
          name: 'Supported thermostat without sample',
          powerCapable: true,
          targets: [{ id: 'target_temperature', value: 21, unit: '°C' }],
        },
      ],
      managed_devices: { unmetered: true, supported: true },
      capacity_priorities: { Home: { unmetered: 1, supported: 2 } },
      mode_device_targets: { Home: { unmetered: 21, supported: 21 } },
    });

    await loadDeviceAndModeSettings();

    const rows = Array.from(document.querySelectorAll<HTMLElement>('#priority-list .device-row'));
    expect(rows.map((row) => row.dataset.deviceId)).toEqual(['unmetered', 'supported']);
    expect(document.querySelector('#priority-list [data-device-id="unmetered"] .mode-target-input')).not.toBeNull();
  });

  it('normalizes loaded priorities to a strict, deterministic order', async () => {
    // Persisted payload has duplicate priorities (dev-1/dev-2 both 5) and a gap.
    // The UI must resolve to the same strict order the planner uses so the list
    // and the runtime agree on which device wins.
    installedHomeyMock().set = vi.fn((key, val, cb) => cb && cb(null));
    installedHomeyMock().get = vi.fn((key, cb) => {
      if (key === 'capacity_priorities') {
        return cb(null, { Home: { 'dev-2': 5, 'dev-1': 5, 'dev-3': 9 } });
      }
      if (key === 'mode_device_targets') return cb(null, {});
      if (key === 'operating_mode') return cb(null, 'Home');
      return cb(null, []);
    });

    await loadDeviceAndModeSettings();

    const { state } = await import('../src/ui/state.ts');
    expect(state.capacityPriorities).toEqual({
      Home: { 'dev-1': 1, 'dev-2': 2, 'dev-3': 3 },
    });
    const ranks = Object.values(state.capacityPriorities.Home);
    expect(new Set(ranks).size).toBe(ranks.length);
  });

  it('shows newly managed devices in the same relative order the planner uses', async () => {
    const stalePriorities = Object.fromEntries(
      Array.from({ length: 99 }, (_, index) => [`stale-${index + 1}`, index + 1]),
    );
    installSettingsHomeyMock({
      target_devices_snapshot: [
        {
          id: 'z-new',
          name: 'Zulu',
          targets: [{ id: 'target_temperature', value: 21, unit: '°C' }],
        },
        {
          id: 'configured',
          name: 'Configured',
          targets: [{ id: 'target_temperature', value: 21, unit: '°C' }],
        },
        {
          id: 'a-new',
          name: 'Alpha',
          targets: [{ id: 'target_temperature', value: 21, unit: '°C' }],
        },
      ],
      // The configured active device remains rank 100 after normalizing the 99
      // stale entries. Newly managed devices have no entry and stay behind it.
      capacity_priorities: { Home: { ...stalePriorities, configured: 100 } },
      mode_device_targets: { Home: {}, Eco: {} },
      managed_devices: { configured: true, 'z-new': true, 'a-new': true },
    });

    await loadDeviceAndModeSettings();

    const { renderPriorities } = await import('../src/ui/modes.ts');
    const { state } = await import('../src/ui/state.ts');
    expect(state.capacityPriorities.Home['a-new']).toBeGreaterThan(state.capacityPriorities.Home.configured);
    expect(state.capacityPriorities.Home['z-new']).toBeGreaterThan(state.capacityPriorities.Home['a-new']);
    expect(state.capacityPriorities.Eco['configured']).toBeTypeOf('number');
    expect(state.capacityPriorities.Eco['a-new']).toBeTypeOf('number');
    expect(state.capacityPriorities.Eco['z-new']).toBeTypeOf('number');
    renderPriorities(state.latestDevices);

    const rows = Array.from(document.querySelectorAll<HTMLElement>('#priority-list .device-row'));
    expect(rows.map((row) => row.dataset.deviceId)).toEqual(['configured', 'a-new', 'z-new']);
    expect(rows.map((row) => row.querySelector('.priority-badge')?.textContent)).toEqual(['#1', '#2', '#3']);

    // The detail surface reads the same compact home order, not retained rank 100.
    const { renderDeviceDetailModes } = await import('../src/ui/deviceDetail/modes.ts');
    const configured = state.latestDevices.find((device) => device.id === 'configured');
    if (!configured) throw new Error('Configured fixture device missing');
    renderDeviceDetailModes(configured);
    const priorityLabel = (mode: string) => document.querySelector(
      `#device-detail-modes [data-mode="${mode}"] .detail-mode-row__priority`,
    )?.textContent;
    expect(priorityLabel('Home')).toBe('Priority 1');
    expect(priorityLabel('Eco')).toBe('Priority 2');

    // A later device/mode arrival is complete before any rendering or user save.
    state.managedMap['later'] = true;
    state.modeTargets.Later = {};
    expect(state.capacityPriorities.Home.later).toBeTypeOf('number');
    expect(state.capacityPriorities.Later.later).toBeTypeOf('number');
  });

  it('renames a mode and updates settings', async () => {
    const setSpy = vi.fn((key, val, cb) => cb && cb(null));
    installedHomeyMock().set = setSpy;
    installedHomeyMock().get = vi.fn((key, cb) => {
      if (key === 'capacity_priorities') return cb(null, { Home: { 'dev-1': 1 } });
      if (key === 'mode_device_targets') return cb(null, { Home: { 'dev-1': 20 } });
      if (key === 'operating_mode') return cb(null, 'Home');
      return cb(null, [
        {
          id: 'dev-1',
          name: 'Heater',
          targets: [{ id: 'target_temperature', value: 21, unit: '°C' }],
        },
      ]);
    });

    await loadDeviceAndModeSettings();

    const renameBtn = document.querySelector('#rename-mode-button') as HTMLButtonElement;
    const modeInput = document.querySelector('#mode-new') as HTMLInputElement;
    const confirmBtn = document.querySelector('#mode-name-confirm') as HTMLButtonElement;
    const modeSelect = document.querySelector('#mode-select') as HTMLSelectElement;
    modeSelect.value = 'Home';
    // Rename reveals the editor (prefilled with the current name); edit + confirm.
    renameBtn.click();
    modeInput.value = 'cozy';
    confirmBtn.click();
    await waitFor(() => Array.from(modeSelect.options).some((o) => o.value === 'cozy'));

    const modeOptions = Array.from(modeSelect.options).map((o) => o.value);
    expect(modeOptions).toContain('cozy');
    expect(setSpy).toHaveBeenCalledWith('operating_mode', 'cozy', expect.any(Function));
    expect(setSpy).toHaveBeenCalledWith('capacity_priorities', { cozy: { 'dev-1': 1 } }, expect.any(Function));
    expect(setSpy).toHaveBeenCalledWith('mode_device_targets', { cozy: { 'dev-1': 20 } }, expect.any(Function));
  });

  it('repoints retained aliases when the same mode is renamed twice', async () => {
    const setSpy = vi.fn((key, val, cb) => cb && cb(null));
    installedHomeyMock().set = setSpy;
    installedHomeyMock().get = vi.fn((key, cb) => {
      if (key === 'capacity_priorities') return cb(null, { Home: { 'dev-1': 1 } });
      if (key === 'mode_device_targets') return cb(null, { Home: { 'dev-1': 20 } });
      if (key === 'operating_mode') return cb(null, 'Home');
      if (key === 'mode_aliases') return cb(null, {});
      return cb(null, []);
    });

    await loadDeviceAndModeSettings();
    const { renameMode } = await import('../src/ui/modes.ts');

    await renameMode('Home', 'Chill');
    await renameMode('Chill', 'Cold');

    const aliasWrites = setSpy.mock.calls.filter(([key]) => key === 'mode_aliases');
    expect(aliasWrites[aliasWrites.length - 1]?.[1]).toEqual({
      home: 'Cold',
      chill: 'Cold',
    });
  });

  it('publishes a rename additively before removing the old mode record', async () => {
    const setSpy = vi.fn((key, val, cb) => cb && cb(null));
    installedHomeyMock().set = setSpy;
    installedHomeyMock().get = vi.fn((key, cb) => {
      if (key === 'capacity_priorities') return cb(null, { Home: { 'dev-1': 1 } });
      if (key === 'mode_device_targets') return cb(null, { Home: { 'dev-1': 20 } });
      if (key === 'operating_mode') return cb(null, 'Home');
      if (key === 'mode_aliases') return cb(null, {});
      return cb(null, []);
    });

    await loadDeviceAndModeSettings();
    const { renameMode } = await import('../src/ui/modes.ts');
    await renameMode('Home', 'Chill');

    const writes = setSpy.mock.calls.map(([key, value]) => ({ key, value }));
    expect(writes).toEqual(expect.arrayContaining([
      {
        key: 'mode_device_targets',
        value: { Home: { 'dev-1': 20 }, Chill: { 'dev-1': 20 } },
      },
      { key: 'mode_aliases', value: { home: 'Chill' } },
      { key: 'mode_device_targets', value: { Chill: { 'dev-1': 20 } } },
    ]));
    const additiveTargetsIndex = writes.findIndex(({ key, value }) => (
      key === 'mode_device_targets'
      && Object.prototype.hasOwnProperty.call(value, 'Home')
      && Object.prototype.hasOwnProperty.call(value, 'Chill')
    ));
    const aliasIndex = writes.findIndex(({ key }) => key === 'mode_aliases');
    const finalTargetsIndex = writes.findIndex(({ key, value }) => (
      key === 'mode_device_targets'
      && !Object.prototype.hasOwnProperty.call(value, 'Home')
    ));
    expect(additiveTargetsIndex).toBeGreaterThanOrEqual(0);
    expect(aliasIndex).toBeGreaterThan(additiveTargetsIndex);
    expect(finalTargetsIndex).toBeGreaterThan(aliasIndex);
  });

  it('keeps active mode separate from editing mode when saving priorities', async () => {
    const setSpy = vi.fn((key, val, cb) => cb && cb(null));
    installedHomeyMock().set = setSpy;
    installedHomeyMock().get = vi.fn((key, cb) => {
      if (key === 'capacity_priorities') return cb(null, { Home: { 'dev-1': 1 }, Away: { 'dev-1': 2 } });
      if (key === 'mode_device_targets') return cb(null, { Home: { 'dev-1': 20 }, Away: { 'dev-1': 16 } });
      if (key === 'operating_mode') return cb(null, 'Home');
      return cb(null, [
        {
          id: 'dev-1',
          name: 'Heater',
          targets: [{ id: 'target_temperature', value: 21, unit: '°C' }],
        },
      ]);
    });

    await loadDeviceAndModeSettings();

    const modeSelect = document.querySelector('#mode-select') as HTMLSelectElement;
    const activeModeSelect = document.querySelector('#active-mode-select') as HTMLSelectElement;
    const priorityForm = document.querySelector('#priority-form') as HTMLFormElement;

    // Initially, both should show 'Home' as active
    expect(activeModeSelect.value).toBe('Home');
    expect(modeSelect.value).toBe('Home');

    // Change the editing mode to 'Away'
    modeSelect.value = 'Away';
    modeSelect.dispatchEvent(new Event('change'));
    await flushPromises();

    // Active mode select should still show 'Home'
    expect(activeModeSelect.value).toBe('Home');

    // Submit the priority form (save priorities for Away mode)
    priorityForm.dispatchEvent(new Event('submit'));
    await flushPromises();

    // Verify that operating_mode was NOT saved (active mode unchanged)
    const operatingModeCalls = setSpy.mock.calls.filter((c) => c[0] === 'operating_mode');
    // Should not have called setSetting with operating_mode when saving priorities
    const prioritySaveCalls = operatingModeCalls.filter((c) => c[1] === 'Away');
    expect(prioritySaveCalls.length).toBe(0);

    // Active mode select should still show 'Home'
    expect(activeModeSelect.value).toBe('Home');
  });

  it('keeps the selected editing mode when the mode catalog reloads', async () => {
    installedHomeyMock().get = vi.fn((key, cb) => {
      if (key === 'capacity_priorities') return cb(null, { Home: { 'dev-1': 1 }, Away: { 'dev-1': 2 } });
      if (key === 'mode_device_targets') return cb(null, { Home: { 'dev-1': 20 }, Away: { 'dev-1': 16 } });
      if (key === 'operating_mode') return cb(null, 'Home');
      return cb(null, [
        {
          id: 'dev-1',
          name: 'Heater',
          targets: [{ id: 'target_temperature', value: 21, unit: '°C' }],
        },
      ]);
    });

    await loadDeviceAndModeSettings();

    const { loadModeAndPriorities } = await import('../src/ui/modes.ts');
    const modeSelect = document.querySelector('#mode-select') as HTMLSelectElement;
    modeSelect.value = 'Away';
    modeSelect.dispatchEvent(new Event('change'));
    await flushPromises();

    await loadModeAndPriorities();

    expect(modeSelect.value).toBe('Away');
  });

  it('copies priorities and targets from the active mode when adding a new mode', async () => {
    const store: Record<string, unknown> = {};
    const setSpy = vi.fn((key, val, cb) => {
      store[key] = val;
      if (cb) cb(null);
    });
    installedHomeyMock().set = setSpy;
    installedHomeyMock().get = vi.fn((key, cb) => {
      if (key === 'capacity_priorities') return cb(null, { Home: { 'dev-1': 1, 'dev-2': 2 } });
      if (key === 'mode_device_targets') return cb(null, { Home: { 'dev-1': 20 } });
      if (key === 'operating_mode') return cb(null, 'Home');
      return cb(null, [
        {
          id: 'dev-1',
          name: 'Heater',
          targets: [{ id: 'target_temperature', value: 21, unit: '°C' }],
        },
        {
          id: 'dev-2',
          name: 'Fan',
          targets: [{ id: 'target_temperature', value: 19, unit: '°C' }],
        },
      ]);
    });

    await loadDeviceAndModeSettings();

    const modeInput = document.querySelector('#mode-new') as HTMLInputElement;
    const addBtn = document.querySelector('#add-mode-button') as HTMLButtonElement;
    const confirmBtn = document.querySelector('#mode-name-confirm') as HTMLButtonElement;

    // "+ New mode" reveals the shared name editor; the name is confirmed there.
    addBtn.click();
    modeInput.value = 'Cozy';
    confirmBtn.click();
    await waitFor(() => Boolean((store.capacity_priorities as Record<string, unknown> | undefined)?.Cozy));

    expect(store.capacity_priorities).toEqual({
      Home: { 'dev-1': 1, 'dev-2': 2 },
      Cozy: { 'dev-1': 1, 'dev-2': 2 },
    });
    expect(store.mode_device_targets).toEqual({
      Home: { 'dev-1': 20 },
      Cozy: { 'dev-1': 20 },
    });
  });

  it('reveals the shared mode-name editor only on demand (hidden at rest)', async () => {
    const store: Record<string, unknown> = {};
    const setSpy = vi.fn((key, val, cb) => { store[key] = val; if (cb) cb(null); });
    installedHomeyMock().set = setSpy;
    installedHomeyMock().get = vi.fn((key, cb) => {
      if (key === 'capacity_priorities') return cb(null, { Home: { 'dev-1': 1 } });
      if (key === 'mode_device_targets') return cb(null, { Home: { 'dev-1': 20 } });
      if (key === 'operating_mode') return cb(null, 'Home');
      return cb(null, [
        { id: 'dev-1', name: 'Heater', targets: [{ id: 'target_temperature', value: 21, unit: '°C' }] },
      ]);
    });

    await loadDeviceAndModeSettings();

    const editor = document.querySelector('#mode-name-editor') as HTMLElement;
    const addBtn = document.querySelector('#add-mode-button') as HTMLButtonElement;
    const cancelBtn = document.querySelector('#mode-name-cancel') as HTMLButtonElement;

    // No lone blank "New mode name" field on the page at rest.
    expect(editor.hidden).toBe(true);
    // "+ New mode" reveals it; Cancel puts it away again.
    addBtn.click();
    expect(editor.hidden).toBe(false);
    cancelBtn.click();
    expect(editor.hidden).toBe(true);
  });

  it('changes active mode when selection changes (auto-save)', async () => {
    const setSpy = vi.fn((key, val, cb) => cb && cb(null));
    installedHomeyMock().set = setSpy;
    installedHomeyMock().get = vi.fn((key, cb) => {
      if (key === 'capacity_priorities') return cb(null, { Home: { 'dev-1': 1 }, Away: { 'dev-1': 2 } });
      if (key === 'mode_device_targets') return cb(null, { Home: { 'dev-1': 20 }, Away: { 'dev-1': 16 } });
      if (key === 'operating_mode') return cb(null, 'Home');
      return cb(null, [
        {
          id: 'dev-1',
          name: 'Heater',
          targets: [{ id: 'target_temperature', value: 21, unit: '°C' }],
        },
      ]);
    });

    await loadDeviceAndModeSettings();

    const activeModeSelect = document.querySelector('#active-mode-select') as HTMLSelectElement;
    const activeModeHeading = document.querySelector<HTMLElement>('#settings-active-mode-summary');

    expect(activeModeHeading).not.toBeNull();
    expect(activeModeHeading?.tagName).toBe('H3');
    expect(activeModeHeading?.textContent).toBe('Current mode');
    expect(activeModeSelect.value).toBe('Home');

    // Change active mode to 'Away' - should auto-save on change
    activeModeSelect.value = 'Away';
    activeModeSelect.dispatchEvent(new Event('change'));
    await flushPromises();

    // Now operating_mode should be saved as 'Away'
    expect(setSpy).toHaveBeenCalledWith('operating_mode', 'Away', expect.any(Function));
    expect(activeModeSelect.value).toBe('Away');
  });

  it('shows different selected values in editing vs active mode dropdowns', async () => {
    const setSpy = vi.fn((key, val, cb) => cb && cb(null));
    installedHomeyMock().set = setSpy;
    installedHomeyMock().get = vi.fn((key, cb) => {
      if (key === 'capacity_priorities') return cb(null, { Home: { 'dev-1': 1 }, Away: { 'dev-1': 2 } });
      if (key === 'mode_device_targets') return cb(null, { Home: { 'dev-1': 20 }, Away: { 'dev-1': 16 } });
      if (key === 'operating_mode') return cb(null, 'Home');
      return cb(null, [
        {
          id: 'dev-1',
          name: 'Heater',
          targets: [{ id: 'target_temperature', value: 21, unit: '°C' }],
        },
      ]);
    });

    await loadDeviceAndModeSettings();

    const modeSelect = document.querySelector('#mode-select') as HTMLSelectElement;
    const activeModeSelect = document.querySelector('#active-mode-select') as HTMLSelectElement;

    // Change only the editing mode
    modeSelect.value = 'Away';
    modeSelect.dispatchEvent(new Event('change'));
    await flushPromises();

    // The two dropdowns should now show different values
    expect(modeSelect.value).toBe('Away');
    expect(activeModeSelect.value).toBe('Home');
  });

  it('updates active mode dropdown when renaming the active mode', async () => {
    const setSpy = vi.fn((key, val, cb) => cb && cb(null));
    installedHomeyMock().set = setSpy;
    installedHomeyMock().get = vi.fn((key, cb) => {
      if (key === 'capacity_priorities') return cb(null, { Home: { 'dev-1': 1 } });
      if (key === 'mode_device_targets') return cb(null, { Home: { 'dev-1': 20 } });
      if (key === 'operating_mode') return cb(null, 'Home');
      return cb(null, [
        {
          id: 'dev-1',
          name: 'Heater',
          targets: [{ id: 'target_temperature', value: 21, unit: '°C' }],
        },
      ]);
    });

    await loadDeviceAndModeSettings();

    const renameBtn = document.querySelector('#rename-mode-button') as HTMLButtonElement;
    const modeInput = document.querySelector('#mode-new') as HTMLInputElement;
    const confirmBtn = document.querySelector('#mode-name-confirm') as HTMLButtonElement;
    const modeSelect = document.querySelector('#mode-select') as HTMLSelectElement;
    const activeModeSelect = document.querySelector('#active-mode-select') as HTMLSelectElement;

    // Rename 'Home' to 'Cozy' via the reveal-and-confirm editor.
    modeSelect.value = 'Home';
    renameBtn.click();
    modeInput.value = 'Cozy';
    confirmBtn.click();
    await waitFor(() => Array.from(modeSelect.options).some((o) => o.value === 'Cozy'));

    // Both dropdowns should now show 'Cozy' (since we renamed the active mode)
    const editingOptions = Array.from(modeSelect.options).map((o) => o.value);
    const activeOptions = Array.from(activeModeSelect.options).map((o) => o.value);

    expect(editingOptions).toContain('Cozy');
    expect(editingOptions).not.toContain('Home');
    expect(activeOptions).toContain('Cozy');
    expect(activeOptions).not.toContain('Home');

    // Active mode should have been updated to 'Cozy'
    expect(setSpy).toHaveBeenCalledWith('operating_mode', 'Cozy', expect.any(Function));
  });


  it('loads device diagnostics through the Homey API when opening device detail', async () => {
    installedHomeyMock().__uiState.deviceDiagnostics = {
      generatedAt: Date.now(),
      windowDays: 21,
      diagnosticsByDeviceId: {
        'dev-1': {
          currentPenaltyLevel: 2,
          starvation: {
            isStarved: true,
            starvedAccumulatedMs: 23 * 60 * 1000,
            starvationEpisodeStartedAt: Date.UTC(2026, 3, 20, 11, 0, 0),
            starvationLastResumedAt: Date.UTC(2026, 3, 20, 11, 15, 0),
            intendedNormalTargetC: 22,
            currentTemperatureC: 18.2,
            starvationCause: 'capacity',
            starvationPauseReason: null,
          },
          windows: {
            '1d': {
              unmetDemandMs: 2 * 60 * 60 * 1000,
              blockedByHeadroomMs: 60 * 60 * 1000,
              blockedByCooldownBackoffMs: 30 * 60 * 1000,
              targetDeficitMs: 2 * 60 * 60 * 1000,
              shedCount: 1,
              restoreCount: 1,
              failedActivationCount: 1,
              stableActivationCount: 0,
              penaltyBumpCount: 1,
              maxPenaltyLevelSeen: 2,
              avgShedToRestoreMs: 15 * 60 * 1000,
              avgRestoreToSetbackMs: 5 * 60 * 1000,
              minRestoreToSetbackMs: 5 * 60 * 1000,
              maxRestoreToSetbackMs: 5 * 60 * 1000,
            },
            '7d': {
              unmetDemandMs: 2 * 60 * 60 * 1000,
              blockedByHeadroomMs: 60 * 60 * 1000,
              blockedByCooldownBackoffMs: 30 * 60 * 1000,
              targetDeficitMs: 2 * 60 * 60 * 1000,
              shedCount: 1,
              restoreCount: 1,
              failedActivationCount: 1,
              stableActivationCount: 0,
              penaltyBumpCount: 1,
              maxPenaltyLevelSeen: 2,
              avgShedToRestoreMs: 15 * 60 * 1000,
              avgRestoreToSetbackMs: 5 * 60 * 1000,
              minRestoreToSetbackMs: 5 * 60 * 1000,
              maxRestoreToSetbackMs: 5 * 60 * 1000,
            },
            '21d': {
              unmetDemandMs: 2 * 60 * 60 * 1000,
              blockedByHeadroomMs: 60 * 60 * 1000,
              blockedByCooldownBackoffMs: 30 * 60 * 1000,
              targetDeficitMs: 2 * 60 * 60 * 1000,
              shedCount: 1,
              restoreCount: 1,
              failedActivationCount: 1,
              stableActivationCount: 0,
              penaltyBumpCount: 1,
              maxPenaltyLevelSeen: 3,
              avgShedToRestoreMs: 15 * 60 * 1000,
              avgRestoreToSetbackMs: 5 * 60 * 1000,
              minRestoreToSetbackMs: 5 * 60 * 1000,
              maxRestoreToSetbackMs: 5 * 60 * 1000,
            },
          },
        },
      },
    };

    await loadDeviceAndModeSettings();
    (installedHomeyMock().api as ReturnType<typeof vi.fn>).mockClear();

    await waitFor(() => document.querySelector('[data-device-id="dev-1"] .pels-device-card__detail-button') !== null);
    const detailButton = document.querySelector('[data-device-id="dev-1"] .pels-device-card__detail-button') as HTMLElement | null;
    detailButton?.click();

    expect((installedHomeyMock().api as ReturnType<typeof vi.fn>).mock.calls.some(
      (call) => call[0] === 'GET' && call[1] === '/ui_device_diagnostics',
    )).toBe(false);

    const diagnosticsDisclosure = document.querySelector('#device-detail-diagnostics-disclosure') as HTMLDetailsElement | null;
    diagnosticsDisclosure!.open = true;
    diagnosticsDisclosure!.dispatchEvent(new Event('toggle'));

    await waitFor(() => (
      (document.querySelector('#device-detail-diagnostics-status') as HTMLElement | null)?.textContent?.includes('Restart backoff level: 2')
        === true
    ));

    expect((installedHomeyMock().api as ReturnType<typeof vi.fn>).mock.calls).toEqual(expect.arrayContaining([
      expect.arrayContaining(['GET', '/ui_device_diagnostics']),
    ]));
    expect(document.querySelector('#device-detail-diagnostics-cards')?.textContent).toContain('Failed activations');
    expect(document.querySelector('#device-detail-diagnostics-cards')?.textContent).toContain('Restart backoff');
    expect(getDiagnosticsMetricValue('Time not served')).toBe('2.0h');
    expect(getDiagnosticsMetricValue('Held-back time')).toBe('23m');
  });

  it('shows a diagnostics unavailable state when the Homey API route fails', async () => {
    const baseApi = buildHomeyApiMock(installedHomeyMock());
    installedHomeyMock().api = vi.fn((method, uri, bodyOrCallback, cb) => {
      const callback = typeof bodyOrCallback === 'function' ? bodyOrCallback : cb;
      if (method === 'GET' && uri === '/ui_device_diagnostics') {
        callback?.(new Error('Cannot GET /api/app/com.barelysufficient.pels/ui_device_diagnostics'));
        return;
      }
      return baseApi(method, uri, bodyOrCallback, cb);
    });

    await loadDeviceAndModeSettings();

    await waitFor(() => document.querySelector('[data-device-id="dev-1"] .pels-device-card__detail-button') !== null);
    const detailButton = document.querySelector('[data-device-id="dev-1"] .pels-device-card__detail-button') as HTMLElement | null;
    detailButton?.click();

    const diagnosticsDisclosure = document.querySelector('#device-detail-diagnostics-disclosure') as HTMLDetailsElement | null;
    diagnosticsDisclosure!.open = true;
    diagnosticsDisclosure!.dispatchEvent(new Event('toggle'));

    await waitFor(() => (
      (document.querySelector('#device-detail-diagnostics-status') as HTMLElement | null)?.textContent === 'Diagnostics unavailable.'
    ));
  });
});
