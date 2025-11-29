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
    </div>
    <section class="panel" data-panel="devices">
      <form id="targets-form">
        <select id="target-mode-select"></select>
      </form>
      <div id="device-list"></div>
      <p id="empty-state" hidden></p>
    </section>
    <section class="panel hidden" data-panel="power">
      <form id="capacity-form"><input id="capacity-limit"><input id="capacity-margin"></form>
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
});
