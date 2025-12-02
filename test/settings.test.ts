/**
 * Basic render test for the settings UI with Homey mocked.
 */
const buildDom = () => {
  document.body.innerHTML = `
    <div id="toast"></div>
    <div id="status-badge"></div>
    <div class="tabs">
      <button class="tab active" data-tab="devices"></button>
      <button class="tab" data-tab="power"></button>
      <button class="tab" data-tab="plan"></button>
    </div>
    <section class="panel" data-panel="devices">
      <form id="targets-form">
        <select id="target-mode-select"></select>
      </form>
      <div id="device-list"></div>
      <p id="empty-state" hidden></p>
    </section>
    <section class="panel hidden" data-panel="power">
      <form id="capacity-form"><input id="capacity-limit"><input id="capacity-margin"><input id="capacity-dry-run" type="checkbox"></form>
      <form id="active-mode-form"><select id="active-mode-select"></select></form>
      <select id="mode-select"></select>
      <input id="mode-new">
      <button id="add-mode-button"></button>
      <button id="delete-mode-button"></button>
      <button id="rename-mode-button"></button>
      <form id="priority-form"></form>
      <div id="priority-list"></div>
      <p id="priority-empty" hidden></p>
      <div id="power-list"></div>
      <p id="power-empty" hidden></p>
    </section>
    <section class="panel hidden" data-panel="plan">
      <div id="plan-list"></div>
      <p id="plan-empty" hidden></p>
      <div id="plan-meta"></div>
      <button id="plan-refresh-button"></button>
    </section>
    <button id="refresh-button"></button>
  `;
};

describe('settings script', () => {
  beforeEach(() => {
    jest.resetModules();
    buildDom();
    // @ts-expect-error expose mock Homey
    global.Homey = {
      ready: jest.fn().mockResolvedValue(undefined),
      set: jest.fn((key, val, cb) => cb && cb(null)),
      get: jest.fn((key, cb) => cb(null, [
        {
          id: 'dev-1',
          name: 'Heater',
          targets: [{ id: 'target_temperature', value: 21, unit: '°C' }],
        },
      ])),
    };
  });

  it('renders devices with target temperature capabilities', async () => {
    // @ts-ignore settings script is plain JS
    await import('../settings/script.js');
    await new Promise((resolve) => setTimeout(resolve, 50));

    const rows = document.querySelectorAll('#device-list .device-row');
    expect(rows.length).toBe(1);
    expect(rows[0].querySelector('.device-row__name')?.textContent).toContain('Heater');
    expect(document.querySelector('#empty-state')?.hasAttribute('hidden')).toBe(true);
    expect(document.querySelector('#status-badge')?.textContent).toBe('Live');
  });

  it('shows empty state when no devices support target temperature', async () => {
    // @ts-expect-error mutate mock
    global.Homey.get = jest.fn((key, cb) => cb(null, []));
    // @ts-expect-error mutate mock
    global.Homey.set = jest.fn((key, val, cb) => cb && cb(null));
    // @ts-ignore settings script is plain JS
    await import('../settings/script.js');
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(document.querySelectorAll('#device-list .device-row').length).toBe(0);
    expect(document.querySelector('#empty-state')?.hasAttribute('hidden')).toBe(false);
  });

  it('renames a mode and updates settings', async () => {
    const setSpy = jest.fn((key, val, cb) => cb && cb(null));
    // @ts-expect-error mutate mock
    global.Homey.set = setSpy;
    // @ts-expect-error mutate mock
    global.Homey.get = jest.fn((key, cb) => {
      if (key === 'capacity_priorities') return cb(null, { Home: { 'dev-1': 1 } });
      if (key === 'mode_device_targets') return cb(null, { Home: { 'dev-1': 20 } });
      if (key === 'capacity_mode') return cb(null, 'Home');
      return cb(null, [
        {
          id: 'dev-1',
          name: 'Heater',
          targets: [{ id: 'target_temperature', value: 21, unit: '°C' }],
        },
      ]);
    });

    // @ts-ignore settings script is plain JS
    await import('../settings/script.js');
    await new Promise((resolve) => setTimeout(resolve, 50));

    const renameBtn = document.querySelector('#rename-mode-button') as HTMLButtonElement;
    const modeInput = document.querySelector('#mode-new') as HTMLInputElement;
    const modeSelect = document.querySelector('#mode-select') as HTMLSelectElement;
    modeSelect.value = 'home';
    modeInput.value = 'cozy';
    renameBtn.click();
    await new Promise((resolve) => setTimeout(resolve, 100));

    const modeOptions = Array.from(modeSelect.options).map((o) => o.value);
    expect(modeOptions).toContain('cozy');
    expect(setSpy).toHaveBeenCalledWith('capacity_mode', 'cozy', expect.any(Function));
    expect(setSpy).toHaveBeenCalledWith('capacity_priorities', { cozy: { 'dev-1': 1 } }, expect.any(Function));
    expect(setSpy).toHaveBeenCalledWith('mode_device_targets', { cozy: { 'dev-1': 20 } }, expect.any(Function));
  });

  it('keeps active mode separate from editing mode when saving priorities', async () => {
    const setSpy = jest.fn((key, val, cb) => cb && cb(null));
    // @ts-expect-error mutate mock
    global.Homey.set = setSpy;
    // @ts-expect-error mutate mock
    global.Homey.get = jest.fn((key, cb) => {
      if (key === 'capacity_priorities') return cb(null, { Home: { 'dev-1': 1 }, Away: { 'dev-1': 2 } });
      if (key === 'mode_device_targets') return cb(null, { Home: { 'dev-1': 20 }, Away: { 'dev-1': 16 } });
      if (key === 'capacity_mode') return cb(null, 'Home');
      return cb(null, [
        {
          id: 'dev-1',
          name: 'Heater',
          targets: [{ id: 'target_temperature', value: 21, unit: '°C' }],
        },
      ]);
    });

    // @ts-ignore settings script is plain JS
    await import('../settings/script.js');
    await new Promise((resolve) => setTimeout(resolve, 50));

    const modeSelect = document.querySelector('#mode-select') as HTMLSelectElement;
    const activeModeSelect = document.querySelector('#active-mode-select') as HTMLSelectElement;
    const priorityForm = document.querySelector('#priority-form') as HTMLFormElement;

    // Initially, both should show 'Home' as active
    expect(activeModeSelect.value).toBe('Home');
    expect(modeSelect.value).toBe('Home');

    // Change the editing mode to 'Away'
    modeSelect.value = 'Away';
    modeSelect.dispatchEvent(new Event('change'));
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Active mode select should still show 'Home'
    expect(activeModeSelect.value).toBe('Home');

    // Submit the priority form (save priorities for Away mode)
    priorityForm.dispatchEvent(new Event('submit'));
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Verify that capacity_mode was NOT saved (active mode unchanged)
    const capacityModeCalls = setSpy.mock.calls.filter((c) => c[0] === 'capacity_mode');
    // Should not have called setSetting with capacity_mode when saving priorities
    const prioritySaveCalls = capacityModeCalls.filter((c) => c[1] === 'Away');
    expect(prioritySaveCalls.length).toBe(0);

    // Active mode select should still show 'Home'
    expect(activeModeSelect.value).toBe('Home');
  });

  it('changes active mode only when explicitly set via active mode form', async () => {
    const setSpy = jest.fn((key, val, cb) => cb && cb(null));
    // @ts-expect-error mutate mock
    global.Homey.set = setSpy;
    // @ts-expect-error mutate mock
    global.Homey.get = jest.fn((key, cb) => {
      if (key === 'capacity_priorities') return cb(null, { Home: { 'dev-1': 1 }, Away: { 'dev-1': 2 } });
      if (key === 'mode_device_targets') return cb(null, { Home: { 'dev-1': 20 }, Away: { 'dev-1': 16 } });
      if (key === 'capacity_mode') return cb(null, 'Home');
      return cb(null, [
        {
          id: 'dev-1',
          name: 'Heater',
          targets: [{ id: 'target_temperature', value: 21, unit: '°C' }],
        },
      ]);
    });

    // @ts-ignore settings script is plain JS
    await import('../settings/script.js');
    await new Promise((resolve) => setTimeout(resolve, 50));

    const activeModeSelect = document.querySelector('#active-mode-select') as HTMLSelectElement;
    const activeModeForm = document.querySelector('#active-mode-form') as HTMLFormElement;

    // Change active mode to 'Away' via the form
    activeModeSelect.value = 'Away';
    activeModeForm.dispatchEvent(new Event('submit'));
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Now capacity_mode should be saved as 'Away'
    expect(setSpy).toHaveBeenCalledWith('capacity_mode', 'Away', expect.any(Function));
  });

  it('shows different selected values in editing vs active mode dropdowns', async () => {
    const setSpy = jest.fn((key, val, cb) => cb && cb(null));
    // @ts-expect-error mutate mock
    global.Homey.set = setSpy;
    // @ts-expect-error mutate mock
    global.Homey.get = jest.fn((key, cb) => {
      if (key === 'capacity_priorities') return cb(null, { Home: { 'dev-1': 1 }, Away: { 'dev-1': 2 } });
      if (key === 'mode_device_targets') return cb(null, { Home: { 'dev-1': 20 }, Away: { 'dev-1': 16 } });
      if (key === 'capacity_mode') return cb(null, 'Home');
      return cb(null, [
        {
          id: 'dev-1',
          name: 'Heater',
          targets: [{ id: 'target_temperature', value: 21, unit: '°C' }],
        },
      ]);
    });

    // @ts-ignore settings script is plain JS
    await import('../settings/script.js');
    await new Promise((resolve) => setTimeout(resolve, 50));

    const modeSelect = document.querySelector('#mode-select') as HTMLSelectElement;
    const activeModeSelect = document.querySelector('#active-mode-select') as HTMLSelectElement;

    // Change only the editing mode
    modeSelect.value = 'Away';
    modeSelect.dispatchEvent(new Event('change'));
    await new Promise((resolve) => setTimeout(resolve, 50));

    // The two dropdowns should now show different values
    expect(modeSelect.value).toBe('Away');
    expect(activeModeSelect.value).toBe('Home');
  });

  it('updates active mode dropdown when renaming the active mode', async () => {
    const setSpy = jest.fn((key, val, cb) => cb && cb(null));
    // @ts-expect-error mutate mock
    global.Homey.set = setSpy;
    // @ts-expect-error mutate mock
    global.Homey.get = jest.fn((key, cb) => {
      if (key === 'capacity_priorities') return cb(null, { Home: { 'dev-1': 1 } });
      if (key === 'mode_device_targets') return cb(null, { Home: { 'dev-1': 20 } });
      if (key === 'capacity_mode') return cb(null, 'Home');
      return cb(null, [
        {
          id: 'dev-1',
          name: 'Heater',
          targets: [{ id: 'target_temperature', value: 21, unit: '°C' }],
        },
      ]);
    });

    // @ts-ignore settings script is plain JS
    await import('../settings/script.js');
    await new Promise((resolve) => setTimeout(resolve, 50));

    const renameBtn = document.querySelector('#rename-mode-button') as HTMLButtonElement;
    const modeInput = document.querySelector('#mode-new') as HTMLInputElement;
    const modeSelect = document.querySelector('#mode-select') as HTMLSelectElement;
    const activeModeSelect = document.querySelector('#active-mode-select') as HTMLSelectElement;

    // Rename 'Home' to 'Cozy'
    modeSelect.value = 'Home';
    modeInput.value = 'Cozy';
    renameBtn.click();
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Both dropdowns should now show 'Cozy' (since we renamed the active mode)
    const editingOptions = Array.from(modeSelect.options).map((o) => o.value);
    const activeOptions = Array.from(activeModeSelect.options).map((o) => o.value);
    
    expect(editingOptions).toContain('Cozy');
    expect(editingOptions).not.toContain('Home');
    expect(activeOptions).toContain('Cozy');
    expect(activeOptions).not.toContain('Home');
    
    // Active mode should have been updated to 'Cozy'
    expect(setSpy).toHaveBeenCalledWith('capacity_mode', 'Cozy', expect.any(Function));
  });
});
