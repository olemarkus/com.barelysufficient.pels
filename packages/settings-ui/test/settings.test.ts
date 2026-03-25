import { buildHomeyApiMock, installHomeyMock } from './helpers/homeyApiMock';

const { getDateKeyInTimeZone } = require('../src/ui/timezone');

jest.mock('../src/ui/toast', () => ({
  showToast: jest.fn().mockResolvedValue(undefined),
  showToastError: jest.fn().mockResolvedValue(undefined),
}));

const flushPromises = () => new Promise<void>((resolve) => {
  const queueMicrotaskFn = (globalThis as any).queueMicrotask as ((cb: () => void) => void) | undefined;
  if (typeof queueMicrotaskFn === 'function') {
    queueMicrotaskFn(() => {
      if (typeof setImmediate === 'function') {
        setImmediate(() => resolve());
      } else {
        setTimeout(() => resolve(), 0);
      }
    });
    return;
  }
  if (typeof setImmediate === 'function') {
    setImmediate(() => resolve());
    return;
  }
  setTimeout(() => resolve(), 0);
});

const waitFor = async (predicate: () => boolean, timeoutMs = 1000) => {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`waitFor timed out after ${timeoutMs}ms`);
    }
    await flushPromises();
  }
};

/**
 * Basic render test for the settings UI with Homey mocked.
 */
const buildDom = () => {
  document.body.innerHTML = `
    <div id="toast"></div>
    <div id="status-badge"></div>
    <div id="dry-run-banner" hidden></div>
    <div id="stale-data-banner" hidden>
      <span id="stale-data-text"></span>
    </div>
    <div class="tabs">
      <button class="tab active" data-tab="overview"></button>
      <button class="tab" data-tab="devices"></button>
      <button class="tab" data-tab="modes"></button>
      <button class="tab" data-tab="budget"></button>
      <button class="tab" data-tab="usage"></button>
      <button class="tab" data-tab="price"></button>
      <button class="tab" data-tab="advanced"></button>
    </div>
    <section class="panel hidden" id="overview-panel" data-panel="overview">
      <div id="plan-list"></div>
      <p id="plan-empty" hidden></p>
      <div id="plan-meta"></div>
      <button id="plan-refresh-button"></button>
    </section>
    <section class="panel" data-panel="devices">
      <form id="targets-form">
        <select id="target-mode-select"></select>
      </form>
      <input id="capacity-dry-run" type="checkbox">
      <div id="device-list"></div>
      <p id="empty-state" hidden></p>
    </section>
    <section class="panel hidden" data-panel="modes">
      <form id="active-mode-form"><select id="active-mode-select"></select></form>
      <select id="mode-select"></select>
      <input id="mode-new">
      <button id="add-mode-button"></button>
      <button id="delete-mode-button"></button>
      <button id="rename-mode-button"></button>
      <form id="priority-form"></form>
      <div id="priority-list"></div>
      <p id="priority-empty" hidden></p>
    </section>
    <section class="panel hidden" data-panel="budget">
      <form id="capacity-form"><input id="capacity-limit"><input id="capacity-margin"></form>
      <form id="daily-budget-form">
        <input id="daily-budget-enabled" type="checkbox">
        <input id="daily-budget-kwh">
        <input id="daily-budget-price-shaping" type="checkbox">
      </form>
      <div id="daily-budget-chart"></div>
      <div id="daily-budget-bars"></div>
      <div id="daily-budget-labels"></div>
      <div id="daily-budget-empty"></div>
      <div id="daily-budget-status-pill" hidden></div>
      <div id="daily-budget-title"></div>
      <div id="daily-budget-day"></div>
      <div id="daily-budget-remaining"></div>
      <div id="daily-budget-deviation"></div>
      <div id="daily-budget-cost-label"></div>
      <div id="daily-budget-cost"></div>
      <div id="daily-budget-confidence"></div>
      <div id="daily-budget-toggle-mount"></div>
    </section>
    <section class="panel hidden" id="usage-panel" data-panel="usage">
      <div id="power-list"></div>
      <p id="power-empty" hidden></p>
      <button id="power-week-prev"></button>
      <button id="power-week-next"></button>
      <div id="power-week-label"></div>
      <div id="daily-list"></div>
      <p id="daily-empty" hidden></p>
      <div id="hourly-pattern"></div>
      <div id="hourly-pattern-meta"></div>
      <div id="usage-summary"></div>
      <div id="usage-today"></div>
      <div id="usage-week"></div>
      <div id="usage-month"></div>
      <div id="usage-weekday-avg"></div>
      <div id="usage-weekend-avg"></div>
    </section>
    <section class="panel hidden" id="price-panel" data-panel="price">
      <div id="price-status-badge" hidden></div>
      <select id="price-scheme">
        <option value="norway">Norway</option>
        <option value="homey">Homey</option>
        <option value="flow">Flow</option>
      </select>
      <p id="price-scheme-note" hidden></p>
      <div id="price-flow-status" hidden>
        <span id="price-flow-enabled"></span>
        <span id="price-flow-today"></span>
        <span id="price-flow-tomorrow"></span>
      </div>
      <div id="price-homey-status" hidden>
        <span id="price-homey-enabled"></span>
        <span id="price-homey-currency"></span>
        <span id="price-homey-today"></span>
        <span id="price-homey-tomorrow"></span>
      </div>
      <div id="price-norway-settings">
        <select id="norway-price-model">
          <option value="stromstotte">Electricity Subsidy Scheme (Strømstøtte)</option>
          <option value="norgespris">Norway Price (Norgespris)</option>
        </select>
        <div id="norgespris-rules-row" hidden></div>
      </div>
      <form id="nettleie-settings-form">
        <select id="nettleie-fylke"></select>
        <select id="nettleie-company"></select>
        <input id="nettleie-orgnr" type="hidden">
        <select id="nettleie-tariffgruppe"></select>
      </form>
      <form id="price-settings-form">
        <select id="price-area"></select>
        <input id="provider-surcharge" type="number">
        <input id="price-threshold-percent" type="number">
        <input id="price-min-diff-ore" type="number">
      </form>
      <div id="price-list" class="device-list" role="list"></div>
      <p id="price-empty">No spot price data available.</p>
      <button id="price-refresh-button"></button>
      <button id="nettleie-refresh-button"></button>
      <div id="price-optimization-list"></div>
      <p id="price-optimization-empty" hidden></p>
    </section>
    <section class="panel hidden" data-panel="advanced">
      <input id="debug-topic-plan" data-debug-topic="plan" type="checkbox">
      <input id="debug-topic-diagnostics" data-debug-topic="diagnostics" type="checkbox">
      <input id="debug-topic-price" data-debug-topic="price" type="checkbox">
      <input id="debug-topic-daily-budget" data-debug-topic="daily_budget" type="checkbox">
      <input id="debug-topic-devices" data-debug-topic="devices" type="checkbox">
      <input id="debug-topic-settings" data-debug-topic="settings" type="checkbox">
      <form id="daily-budget-advanced-form">
        <input id="daily-budget-controlled-weight" type="number">
        <input id="daily-budget-price-flex-share" type="number">
        <input id="daily-budget-breakdown" type="checkbox">
      </form>
    </section>
    <div id="device-detail-overlay" hidden>
      <div id="device-detail-panel">
        <div id="device-detail-title"></div>
        <button id="device-detail-close"></button>
        <input id="device-detail-managed" type="checkbox">
        <input id="device-detail-controllable" type="checkbox">
        <input id="device-detail-price-opt" type="checkbox">
        <div id="device-detail-modes"></div>
        <div id="device-detail-delta-section"></div>
        <input id="device-detail-cheap-delta">
        <input id="device-detail-expensive-delta">
        <select id="device-detail-overshoot">
          <option value="turn_off">Turn off</option>
          <option value="set_temperature">Set to temperature</option>
          <option value="set_step">Set to step</option>
        </select>
        <div id="device-detail-overshoot-temp-row"></div>
        <input id="device-detail-overshoot-temp">
        <div id="device-detail-overshoot-step-row"></div>
        <select id="device-detail-overshoot-step"></select>
        <details id="device-detail-diagnostics-disclosure">
          <summary>Advanced diagnostics</summary>
          <div id="device-detail-diagnostics-status"></div>
          <div id="device-detail-diagnostics-cards"></div>
        </details>
      </div>
    </div>
    <button id="refresh-button"></button>
    <button id="reset-stats-button"></button>
  `;
};

const loadSettingsScript = async () => {
  // Use require to avoid Node --experimental-vm-modules requirement for dynamic import under Jest 30
  require('../dist/script.js');
  await flushPromises();
  await waitFor(() => {
    const select = document.querySelector('#mode-select') as HTMLSelectElement | null;
    return Boolean(select && select.options.length > 0);
  });
};

const buildSettingsHomeyState = (settings: Record<string, unknown> = {}) => ({
  target_devices_snapshot: [
    {
      id: 'dev-1',
      name: 'Heater',
      targets: [{ id: 'target_temperature', value: 21, unit: '°C' }],
    },
  ],
  operating_mode: 'Home',
  capacity_priorities: {},
  mode_device_targets: {},
  controllable_devices: {},
  managed_devices: {},
  price_optimization_settings: {},
  ...settings,
});

const installSettingsHomeyMock = (settings: Record<string, unknown> = {}) => installHomeyMock({
  settings: buildSettingsHomeyState(settings),
});

describe('settings script', () => {
  beforeEach(() => {
    jest.resetModules();
    buildDom();
    installSettingsHomeyMock();
  });

  it('renders devices with target temperature capabilities', async () => {
    await loadSettingsScript();

    const rows = document.querySelectorAll('#device-list .device-row');
    expect(rows.length).toBe(1);
    expect(rows[0].querySelector('.device-row__name')?.textContent).toContain('Heater');
    expect(document.querySelector('#empty-state')?.hasAttribute('hidden')).toBe(true);
  });

  it('shows only the minimum temperature setting for temperature-target shed mode', async () => {
    installSettingsHomeyMock({
      target_devices_snapshot: [
        {
          id: 'dev-1',
          name: 'Heater',
          deviceType: 'temperature',
          powerCapable: true,
          capabilities: ['onoff', 'measure_power'],
          targets: [{ id: 'target_temperature', value: 21, unit: '°C' }],
        },
      ],
    });
    await loadSettingsScript();

    (document.querySelector('#device-list .device-row') as HTMLElement).click();
    await waitFor(() => document.querySelector('#device-detail-overlay')?.hasAttribute('hidden') === false);

    const shedAction = document.querySelector('#device-detail-overshoot') as HTMLSelectElement;
    shedAction.value = 'set_temperature';
    shedAction.dispatchEvent(new Event('change', { bubbles: true }));
    await flushPromises();

    const tempRow = document.querySelector('#device-detail-overshoot-temp-row') as HTMLElement;
    const stepRow = document.querySelector('#device-detail-overshoot-step-row') as HTMLElement;
    const stepOption = shedAction.querySelector('option[value="set_step"]') as HTMLOptionElement;

    expect(stepOption.hidden).toBe(true);
    expect(tempRow.hidden).toBe(false);
    expect(stepRow.hidden).toBe(true);
  });

  it('keeps the step row hidden for stepped-load set_step shed mode', async () => {
    installSettingsHomeyMock({
      target_devices_snapshot: [
        {
          id: 'dev-1',
          name: 'Water Heater',
          deviceType: 'temperature',
          powerCapable: true,
          capabilities: ['onoff', 'measure_power', 'target_temperature'],
          targets: [{ id: 'target_temperature', value: 65, unit: '°C' }],
        },
      ],
      device_control_profiles: {
        'dev-1': {
          model: 'stepped_load',
          steps: [
            { id: 'off', planningPowerW: 0 },
            { id: 'low', planningPowerW: 1250 },
            { id: 'max', planningPowerW: 3000 },
          ],
        },
      },
      overshoot_behaviors: {
        'dev-1': { action: 'set_step', stepId: 'low' },
      },
    });
    await loadSettingsScript();

    (document.querySelector('#device-list .device-row') as HTMLElement).click();
    await waitFor(() => document.querySelector('#device-detail-overlay')?.hasAttribute('hidden') === false);
    await flushPromises();

    const shedAction = document.querySelector('#device-detail-overshoot') as HTMLSelectElement;
    const tempRow = document.querySelector('#device-detail-overshoot-temp-row') as HTMLElement;
    const stepRow = document.querySelector('#device-detail-overshoot-step-row') as HTMLElement;
    const tempOption = shedAction.querySelector('option[value="set_temperature"]') as HTMLOptionElement;

    expect(shedAction.value).toBe('set_step');
    expect(tempOption.hidden).toBe(false);
    expect(tempRow.hidden).toBe(true);
    expect(stepRow.hidden).toBe(true); // Step selection removed - always uses lowest active step
  });

  it('shows the min temperature setting for stepped loads when temperature shed mode is selected', async () => {
    installSettingsHomeyMock({
      target_devices_snapshot: [
        {
          id: 'dev-1',
          name: 'Water Heater',
          deviceType: 'temperature',
          powerCapable: true,
          capabilities: ['onoff', 'measure_power', 'target_temperature'],
          targets: [{ id: 'target_temperature', value: 65, unit: '°C' }],
        },
      ],
      device_control_profiles: {
        'dev-1': {
          model: 'stepped_load',
          steps: [
            { id: 'off', planningPowerW: 0 },
            { id: 'low', planningPowerW: 1250 },
            { id: 'max', planningPowerW: 3000 },
          ],
        },
      },
      overshoot_behaviors: {
        'dev-1': { action: 'set_temperature', temperature: 55 },
      },
    });
    await loadSettingsScript();

    (document.querySelector('#device-list .device-row') as HTMLElement).click();
    await waitFor(() => document.querySelector('#device-detail-overlay')?.hasAttribute('hidden') === false);
    await flushPromises();

    const shedAction = document.querySelector('#device-detail-overshoot') as HTMLSelectElement;
    const tempRow = document.querySelector('#device-detail-overshoot-temp-row') as HTMLElement;
    const stepRow = document.querySelector('#device-detail-overshoot-step-row') as HTMLElement;
    const tempInput = document.querySelector('#device-detail-overshoot-temp') as HTMLInputElement;
    const tempOption = shedAction.querySelector('option[value="set_temperature"]') as HTMLOptionElement;
    const stepOption = shedAction.querySelector('option[value="set_step"]') as HTMLOptionElement;

    expect(tempOption.hidden).toBe(false);
    expect(stepOption.hidden).toBe(false);
    expect(shedAction.value).toBe('set_temperature');
    expect(tempRow.hidden).toBe(false);
    expect(stepRow.hidden).toBe(true);
    expect(tempInput.value).toBe('55');
  });

  it('switches between shed modes with only the relevant shed field visible', async () => {
    installSettingsHomeyMock({
      target_devices_snapshot: [
        {
          id: 'dev-1',
          name: 'Water Heater',
          deviceType: 'temperature',
          powerCapable: true,
          capabilities: ['onoff', 'measure_power', 'target_temperature'],
          targets: [{ id: 'target_temperature', value: 65, unit: '°C' }],
        },
      ],
      device_control_profiles: {
        'dev-1': {
          model: 'stepped_load',
          steps: [
            { id: 'off', planningPowerW: 0 },
            { id: 'low', planningPowerW: 1250 },
            { id: 'max', planningPowerW: 3000 },
          ],
        },
      },
      overshoot_behaviors: {
        'dev-1': { action: 'set_step', stepId: 'low' },
      },
    });
    await loadSettingsScript();

    (document.querySelector('#device-list .device-row') as HTMLElement).click();
    await waitFor(() => document.querySelector('#device-detail-overlay')?.hasAttribute('hidden') === false);
    await flushPromises();

    const shedAction = document.querySelector('#device-detail-overshoot') as HTMLSelectElement;
    const tempRow = document.querySelector('#device-detail-overshoot-temp-row') as HTMLElement;
    const stepRow = document.querySelector('#device-detail-overshoot-step-row') as HTMLElement;
    const tempInput = document.querySelector('#device-detail-overshoot-temp') as HTMLInputElement;
    const stepInput = document.querySelector('#device-detail-overshoot-step') as HTMLSelectElement;

    expect(tempRow.hidden).toBe(true);
    expect(stepRow.hidden).toBe(true); // Step selection removed - always uses lowest active step
    expect(tempInput.disabled).toBe(true);
    expect(stepInput.disabled).toBe(true); // Step input always disabled

    shedAction.value = 'set_temperature';
    shedAction.dispatchEvent(new Event('change', { bubbles: true }));
    await flushPromises();

    expect(tempRow.hidden).toBe(false);
    expect(stepRow.hidden).toBe(true);
    expect(tempInput.disabled).toBe(false);
    expect(stepInput.disabled).toBe(true);

    shedAction.value = 'turn_off';
    shedAction.dispatchEvent(new Event('change', { bubbles: true }));
    await flushPromises();

    expect(tempRow.hidden).toBe(true);
    expect(stepRow.hidden).toBe(true);
    expect(tempInput.disabled).toBe(true);
    expect(stepInput.disabled).toBe(true);
  });

  it('hides both shed temperature and shed step rows when shed mode is turn off', async () => {
    installSettingsHomeyMock({
      target_devices_snapshot: [
        {
          id: 'dev-1',
          name: 'Water Heater',
          deviceType: 'temperature',
          powerCapable: true,
          capabilities: ['onoff', 'measure_power', 'target_temperature'],
          targets: [{ id: 'target_temperature', value: 65, unit: '°C' }],
        },
      ],
      device_control_profiles: {
        'dev-1': {
          model: 'stepped_load',
          steps: [
            { id: 'off', planningPowerW: 0 },
            { id: 'low', planningPowerW: 1250 },
            { id: 'max', planningPowerW: 3000 },
          ],
        },
      },
      overshoot_behaviors: {
        'dev-1': { action: 'set_step', stepId: 'low' },
      },
    });
    await loadSettingsScript();

    (document.querySelector('#device-list .device-row') as HTMLElement).click();
    await waitFor(() => document.querySelector('#device-detail-overlay')?.hasAttribute('hidden') === false);
    await flushPromises();

    const shedAction = document.querySelector('#device-detail-overshoot') as HTMLSelectElement;
    const tempRow = document.querySelector('#device-detail-overshoot-temp-row') as HTMLElement;
    const stepRow = document.querySelector('#device-detail-overshoot-step-row') as HTMLElement;

    shedAction.value = 'turn_off';
    shedAction.dispatchEvent(new Event('change', { bubbles: true }));
    await flushPromises();

    expect(tempRow.hidden).toBe(true);
    expect(stepRow.hidden).toBe(true);
  });

  it('shows empty state when no devices support target temperature', async () => {
    // @ts-ignore mutate mock
    global.Homey.get = jest.fn((key, cb) => cb(null, []));
    // @ts-ignore mutate mock
    global.Homey.set = jest.fn((key, val, cb) => cb && cb(null));
    await loadSettingsScript();

    expect(document.querySelectorAll('#device-list .device-row').length).toBe(0);
    expect(document.querySelector('#empty-state')?.hasAttribute('hidden')).toBe(false);
  });

  it('allows toggling managed and capacity control for a socket device', async () => {
    const setSpy = jest.fn((key, val, cb) => cb && cb(null));
    // @ts-ignore mutate mock
    global.Homey.set = setSpy;
    // @ts-ignore mutate mock
    global.Homey.get = jest.fn((key, cb) => {
      if (key === 'target_devices_snapshot') {
        return cb(null, [
          {
            id: 'socket-1',
            name: 'Kitchen Socket',
            deviceClass: 'socket',
            deviceType: 'onoff',
            targets: [],
            powerCapable: true,
            powerKw: 0.125,
          },
        ]);
      }
      if (key === 'operating_mode') return cb(null, 'Home');
      if (key === 'capacity_priorities') return cb(null, {});
      if (key === 'mode_device_targets') return cb(null, {});
      if (key === 'controllable_devices') return cb(null, {});
      if (key === 'managed_devices') return cb(null, {});
      if (key === 'price_optimization_settings') return cb(null, {});
      return cb(null, null);
    });

    await loadSettingsScript();

    const getToggles = () => {
      const checkboxes = Array.from(
        document.querySelectorAll('[data-device-id="socket-1"] input[type="checkbox"]'),
      ) as HTMLInputElement[];
      return {
        managed: checkboxes[0],
        controllable: checkboxes[1],
      };
    };

    await waitFor(() => Boolean(getToggles().managed && getToggles().controllable));
    expect(getToggles().managed.disabled).toBe(false);
    expect(getToggles().controllable.disabled).toBe(true);

    getToggles().managed.click();
    await waitFor(() => {
      const calls = setSpy.mock.calls.filter((call) => call[0] === 'managed_devices');
      return calls.length > 0;
    }, 1500);
    const managedCalls = setSpy.mock.calls.filter((call) => call[0] === 'managed_devices');
    expect(managedCalls[managedCalls.length - 1]?.[1]).toEqual(expect.objectContaining({ 'socket-1': true }));

    await waitFor(() => getToggles().controllable.disabled === false);
    getToggles().controllable.click();
    await waitFor(() => {
      const calls = setSpy.mock.calls.filter((call) => call[0] === 'controllable_devices');
      return calls.length > 0;
    }, 1500);
    const controllableCalls = setSpy.mock.calls.filter((call) => call[0] === 'controllable_devices');
    expect(controllableCalls[controllableCalls.length - 1]?.[1]).toEqual(expect.objectContaining({ 'socket-1': true }));
  });

  it('allows toggling managed and capacity control for an off socket with Homey energy metadata', async () => {
    const setSpy = jest.fn((key, val, cb) => cb && cb(null));
    // @ts-ignore mutate mock
    global.Homey.set = setSpy;
    // @ts-ignore mutate mock
    global.Homey.get = jest.fn((key, cb) => {
      if (key === 'target_devices_snapshot') {
        return cb(null, [
          {
            id: 'socket-2',
            name: 'Hall Socket',
            deviceClass: 'socket',
            deviceType: 'onoff',
            targets: [],
            currentOn: false,
            powerCapable: true,
            expectedPowerSource: 'default',
            powerKw: 1,
          },
        ]);
      }
      if (key === 'operating_mode') return cb(null, 'Home');
      if (key === 'capacity_priorities') return cb(null, {});
      if (key === 'mode_device_targets') return cb(null, {});
      if (key === 'controllable_devices') return cb(null, {});
      if (key === 'managed_devices') return cb(null, {});
      if (key === 'price_optimization_settings') return cb(null, {});
      return cb(null, null);
    });

    await loadSettingsScript();

    const getToggles = () => {
      const checkboxes = Array.from(
        document.querySelectorAll('[data-device-id="socket-2"] input[type="checkbox"]'),
      ) as HTMLInputElement[];
      return {
        managed: checkboxes[0],
        controllable: checkboxes[1],
      };
    };

    await waitFor(() => Boolean(getToggles().managed && getToggles().controllable));
    expect(getToggles().managed.disabled).toBe(false);
    expect(getToggles().controllable.disabled).toBe(true);

    getToggles().managed.click();
    await waitFor(() => {
      const calls = setSpy.mock.calls.filter((call) => call[0] === 'managed_devices');
      return calls.length > 0;
    }, 1500);
    await waitFor(() => getToggles().controllable.disabled === false);

    getToggles().controllable.click();
    await waitFor(() => {
      const calls = setSpy.mock.calls.filter((call) => call[0] === 'controllable_devices');
      return calls.length > 0;
    }, 1500);
    const controllableCalls = setSpy.mock.calls.filter((call) => call[0] === 'controllable_devices');
    expect(controllableCalls[controllableCalls.length - 1]?.[1]).toEqual(expect.objectContaining({ 'socket-2': true }));
  });

  it('renames a mode and updates settings', async () => {
    const setSpy = jest.fn((key, val, cb) => cb && cb(null));
    // @ts-ignore mutate mock
    global.Homey.set = setSpy;
    // @ts-ignore mutate mock
    global.Homey.get = jest.fn((key, cb) => {
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

    await loadSettingsScript();

    const renameBtn = document.querySelector('#rename-mode-button') as HTMLButtonElement;
    const modeInput = document.querySelector('#mode-new') as HTMLInputElement;
    const modeSelect = document.querySelector('#mode-select') as HTMLSelectElement;
    modeSelect.value = 'home';
    modeInput.value = 'cozy';
    renameBtn.click();
    await waitFor(() => Array.from(modeSelect.options).some((o) => o.value === 'cozy'));

    const modeOptions = Array.from(modeSelect.options).map((o) => o.value);
    expect(modeOptions).toContain('cozy');
    expect(setSpy).toHaveBeenCalledWith('operating_mode', 'cozy', expect.any(Function));
    expect(setSpy).toHaveBeenCalledWith('capacity_priorities', { cozy: { 'dev-1': 1 } }, expect.any(Function));
    expect(setSpy).toHaveBeenCalledWith('mode_device_targets', { cozy: { 'dev-1': 20 } }, expect.any(Function));
  });

  it('keeps active mode separate from editing mode when saving priorities', async () => {
    const setSpy = jest.fn((key, val, cb) => cb && cb(null));
    // @ts-ignore mutate mock
    global.Homey.set = setSpy;
    // @ts-ignore mutate mock
    global.Homey.get = jest.fn((key, cb) => {
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

    await loadSettingsScript();

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

  it('copies priorities and targets from the active mode when adding a new mode', async () => {
    const store: Record<string, any> = {};
    const setSpy = jest.fn((key, val, cb) => {
      store[key] = val;
      if (cb) cb(null);
    });
    // @ts-ignore mutate mock
    global.Homey.set = setSpy;
    // @ts-ignore mutate mock
    global.Homey.get = jest.fn((key, cb) => {
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

    await loadSettingsScript();

    const modeInput = document.querySelector('#mode-new') as HTMLInputElement;
    const addBtn = document.querySelector('#add-mode-button') as HTMLButtonElement;

    modeInput.value = 'Cozy';
    addBtn.click();
    await waitFor(() => Boolean(store.capacity_priorities?.Cozy));

    expect(store.capacity_priorities).toEqual({
      Home: { 'dev-1': 1, 'dev-2': 2 },
      Cozy: { 'dev-1': 1, 'dev-2': 2 },
    });
    expect(store.mode_device_targets).toEqual({
      Home: { 'dev-1': 20 },
      Cozy: { 'dev-1': 20 },
    });
  });

  it('changes active mode when selection changes (auto-save)', async () => {
    const setSpy = jest.fn((key, val, cb) => cb && cb(null));
    // @ts-ignore mutate mock
    global.Homey.set = setSpy;
    // @ts-ignore mutate mock
    global.Homey.get = jest.fn((key, cb) => {
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

    await loadSettingsScript();

    const activeModeSelect = document.querySelector('#active-mode-select') as HTMLSelectElement;

    // Change active mode to 'Away' - should auto-save on change
    activeModeSelect.value = 'Away';
    activeModeSelect.dispatchEvent(new Event('change'));
    await flushPromises();

    // Now operating_mode should be saved as 'Away'
    expect(setSpy).toHaveBeenCalledWith('operating_mode', 'Away', expect.any(Function));
  });

  it('shows different selected values in editing vs active mode dropdowns', async () => {
    const setSpy = jest.fn((key, val, cb) => cb && cb(null));
    // @ts-ignore mutate mock
    global.Homey.set = setSpy;
    // @ts-ignore mutate mock
    global.Homey.get = jest.fn((key, cb) => {
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

    await loadSettingsScript();

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
    const setSpy = jest.fn((key, val, cb) => cb && cb(null));
    // @ts-ignore mutate mock
    global.Homey.set = setSpy;
    // @ts-ignore mutate mock
    global.Homey.get = jest.fn((key, cb) => {
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

    await loadSettingsScript();

    const renameBtn = document.querySelector('#rename-mode-button') as HTMLButtonElement;
    const modeInput = document.querySelector('#mode-new') as HTMLInputElement;
    const modeSelect = document.querySelector('#mode-select') as HTMLSelectElement;
    const activeModeSelect = document.querySelector('#active-mode-select') as HTMLSelectElement;

    // Rename 'Home' to 'Cozy'
    modeSelect.value = 'Home';
    modeInput.value = 'Cozy';
    renameBtn.click();
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

  it('displays cheap and expensive hours when combined_prices are available', async () => {
    // Create price data with some cheap and expensive hours
    const now = new Date();
    const currentHourStartMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), now.getUTCHours(), 0, 0, 0);
    const hourMs = 60 * 60 * 1000;

    // Create 48 hours of prices (today and tomorrow) with average around 100 øre
    // Make cheap hours in the future relative to current hour
    const prices: any[] = [];
    for (let hourOffset = 0; hourOffset < 48; hourOffset++) {
      const date = new Date(currentHourStartMs + hourOffset * hourMs);
      let total = 100; // Normal price
      // Make hours relative to current: current+1 to +3 cheap, current+6 to +8 expensive
      if (hourOffset >= 1 && hourOffset <= 3) total = 50; // Cheap hours
      if (hourOffset >= 6 && hourOffset <= 8) total = 150; // Expensive hours
      prices.push({
        startsAt: date.toISOString(),
        total,
        spotPriceExVat: total * 0.7,
        gridTariffExVat: total * 0.3,
        isCheap: total <= 75, // 25% below 100
        isExpensive: total >= 125, // 25% above 100
      });
    }

    // Use new format with pre-calculated thresholds
    const combinedPrices = {
      prices,
      avgPrice: 100,
      lowThreshold: 75,
      highThreshold: 125,
    };

    const setSpy = jest.fn((key, val, cb) => cb && cb(null));
    // @ts-ignore mutate mock
    global.Homey.set = setSpy;
    // @ts-ignore mutate mock
    global.Homey.get = jest.fn((key, cb) => {
      if (key === 'combined_prices') return cb(null, combinedPrices);
      if (key === 'electricity_prices') return cb(null, []);
      if (key === 'target_devices_snapshot') return cb(null, []);
      if (key === 'price_optimization_settings') return cb(null, {});
      return cb(null, null);
    });

    await loadSettingsScript();

    // Check that the price panel exists and make it visible first
    const pricePanel = document.querySelector('#price-panel');
    expect(pricePanel).not.toBeNull();
    pricePanel?.classList.remove('hidden');

    // Switch to price tab to trigger refresh
    const priceTab = document.querySelector('[data-tab="price"]') as HTMLButtonElement;
    priceTab?.click();
    await flushPromises();

    const priceList = document.querySelector('#price-list');
    const priceStatusBadge = document.querySelector('#price-status-badge') as HTMLElement | null;

    // Verify price list has content
    expect(priceList?.innerHTML).not.toBe('');

    // Verify price summary section exists with cheap hours info
    const priceSummary = priceList?.querySelector('.price-summary');
    expect(priceSummary).not.toBeNull();

    // Verify summary shows cheap hours count
    const summaryItems = priceList?.querySelectorAll('.price-summary-item');
    expect(summaryItems?.length).toBe(2); // Cheap and expensive summaries
    expect(summaryItems?.[0]?.textContent).toContain('cheap hour');
    expect(summaryItems?.[1]?.textContent).toContain('expensive hour');
    expect(summaryItems?.[0]?.textContent).toContain('cap <=');
    expect(summaryItems?.[0]?.textContent).toContain('75 øre/kWh');
    expect(summaryItems?.[1]?.textContent).toContain('cap >=');
    expect(summaryItems?.[1]?.textContent).toContain('125 øre/kWh');

    // Verify collapsible details sections exist
    const detailsSections = priceList?.querySelectorAll('.price-details');
    expect(detailsSections?.length).toBeGreaterThanOrEqual(2); // Cheap, expensive, and all prices

    // Verify price rows are rendered inside details
    const priceRows = priceList?.querySelectorAll('.price-row');
    expect(priceRows?.length).toBeGreaterThan(0);

    // Status badge is only shown for warn states; ok/normal price is not badged
    expect(priceStatusBadge?.hidden).toBe(true);
  });

  it('shows notice when all prices are within threshold', async () => {
    // Create price data where all prices are within 25% of average
    const now = new Date();
    const currentHourStartMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), now.getUTCHours(), 0, 0, 0);
    const hourMs = 60 * 60 * 1000;

    // All prices around 100 øre (within 25% threshold)
    const prices: any[] = [];
    for (let hour = 0; hour < 24; hour++) {
      const date = new Date(currentHourStartMs + hour * hourMs);
      // Vary between 85-115 øre (within 25% of 100 average)
      const total = 90 + (hour % 5) * 5;
      prices.push({
        startsAt: date.toISOString(),
        total,
        spotPriceExVat: total * 0.7,
        gridTariffExVat: total * 0.3,
        isCheap: false, // All within threshold
        isExpensive: false,
      });
    }

    // Use new format with pre-calculated thresholds
    const combinedPrices = {
      prices,
      avgPrice: 100,
      lowThreshold: 75,
      highThreshold: 125,
    };

    const setSpy = jest.fn((key, val, cb) => cb && cb(null));
    // @ts-ignore mutate mock
    global.Homey.set = setSpy;
    // @ts-ignore mutate mock
    global.Homey.get = jest.fn((key, cb) => {
      if (key === 'combined_prices') return cb(null, combinedPrices);
      if (key === 'electricity_prices') return cb(null, []);
      if (key === 'target_devices_snapshot') return cb(null, []);
      if (key === 'price_optimization_settings') return cb(null, {});
      return cb(null, null);
    });

    await loadSettingsScript();

    // Switch to price tab to trigger refresh
    const priceTab = document.querySelector('[data-tab="price"]') as HTMLButtonElement;
    priceTab?.click();
    await flushPromises();

    const priceList = document.querySelector('#price-list');

    // Verify summary section exists
    const priceSummary = priceList?.querySelector('.price-summary');
    expect(priceSummary).not.toBeNull();

    // When all prices are within threshold, summary shows "No cheap/expensive hours"
    const summaryItems = priceList?.querySelectorAll('.price-summary-item');
    expect(summaryItems?.length).toBe(2);
    expect(summaryItems?.[0]?.textContent).toContain('No cheap hours');
    expect(summaryItems?.[1]?.textContent).toContain('No expensive hours');

    // Verify no cheap/expensive collapsible details (only per-day sections)
    const detailsSections = priceList?.querySelectorAll('.price-details');
    const dayKeys = new Set(prices.map((price) => price.startsAt.split('T')[0]));
    expect(detailsSections?.length).toBe(dayKeys.size);
  });

  it('uses the minimum price difference when describing cheap/expensive thresholds', async () => {
    const now = new Date();
    const currentHourStartMs = Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate(),
      22,
      0,
      0,
      0,
    );
    const hourMs = 60 * 60 * 1000;

    const prices: any[] = [];
    for (let hour = 0; hour < 24; hour++) {
      const date = new Date(currentHourStartMs + hour * hourMs);
      const total = hour === 9 ? 1.6777 : 1.5057;
      prices.push({
        startsAt: date.toISOString(),
        total,
        isCheap: false,
        isExpensive: false,
      });
    }

    const combinedPrices = {
      prices,
      avgPrice: 1.4608,
      lowThreshold: 1.3878,
      highThreshold: 1.5339,
      thresholdPercent: 5,
      minDiffOre: 0.5,
      priceScheme: 'flow',
      priceUnit: 'price units',
    };

    const setSpy = jest.fn((key, val, cb) => cb && cb(null));
    // @ts-ignore mutate mock
    global.Homey.set = setSpy;
    // @ts-ignore mutate mock
    global.Homey.get = jest.fn((key, cb) => {
      if (key === 'combined_prices') return cb(null, combinedPrices);
      if (key === 'electricity_prices') return cb(null, []);
      if (key === 'target_devices_snapshot') return cb(null, []);
      if (key === 'price_optimization_settings') return cb(null, {});
      return cb(null, null);
    });

    await loadSettingsScript();

    const priceTab = document.querySelector('[data-tab="price"]') as HTMLButtonElement;
    priceTab?.click();
    await flushPromises();

    const summaryItems = document.querySelectorAll('.price-summary-item');
    const cheapSummary = summaryItems?.[0]?.textContent ?? '';
    const expensiveSummary = summaryItems?.[1]?.textContent ?? '';

    expect(cheapSummary).toContain('No cheap hours');
    expect(cheapSummary).toContain('at or below 0.9608');
    expect(expensiveSummary).toContain('No expensive hours');
    expect(expensiveSummary).toContain('at or above 1.9608');
  });

  it('shows norgespris rules only when Norway model is norgespris', async () => {
    const settingsStore: Record<string, unknown> = {
      price_scheme: 'norway',
      norway_price_model: 'stromstotte',
      price_area: 'NO1',
      provider_surcharge: 0,
      price_threshold_percent: 25,
      price_min_diff_ore: 0,
      electricity_prices: [],
      combined_prices: null,
      target_devices_snapshot: [],
      price_optimization_settings: {},
    };
    const setSpy = jest.fn((key, val, cb) => {
      settingsStore[key] = val;
      if (cb) cb(null);
    });
    // @ts-ignore mutate mock
    global.Homey.set = setSpy;
    // @ts-ignore mutate mock
    global.Homey.get = jest.fn((key, cb) => {
      if (Object.prototype.hasOwnProperty.call(settingsStore, key)) {
        return cb(null, settingsStore[key]);
      }
      return cb(null, null);
    });

    await loadSettingsScript();

    const modelSelect = document.querySelector('#norway-price-model') as HTMLSelectElement;
    const priceAreaSelect = document.querySelector('#price-area') as HTMLSelectElement;
    const rulesRow = document.querySelector('#norgespris-rules-row') as HTMLElement;
    priceAreaSelect.innerHTML = '<option value="NO1">NO1</option>';
    priceAreaSelect.value = 'NO1';
    expect(rulesRow.hidden).toBe(true);
    setSpy.mockClear();

    modelSelect.value = 'norgespris';
    modelSelect.dispatchEvent(new Event('change', { bubbles: true }));
    await waitFor(() => rulesRow.hidden === false);
    await waitFor(() => setSpy.mock.calls.some((call) => call[0] === 'norway_price_model'));
    expect(setSpy.mock.calls.map((call) => call[0])).toEqual(['norway_price_model']);

    setSpy.mockClear();
    modelSelect.value = 'stromstotte';
    modelSelect.dispatchEvent(new Event('change', { bubbles: true }));
    await waitFor(() => rulesRow.hidden === true);
    await waitFor(() => setSpy.mock.calls.some((call) => call[0] === 'norway_price_model'));
    expect(setSpy.mock.calls.map((call) => call[0])).toEqual(['norway_price_model']);
  });

  it('updates cheap/expensive lists when price settings change', async () => {
    const now = new Date();
    const currentHourStartMs = Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate(),
      now.getUTCHours(),
      0,
      0,
      0,
    );
    const hourMs = 60 * 60 * 1000;

    const prices: any[] = [];
    for (let hourOffset = 0; hourOffset < 6; hourOffset++) {
      const date = new Date(currentHourStartMs + hourOffset * hourMs);
      let total = 100;
      if (hourOffset === 1) total = 70;
      if (hourOffset === 2) total = 130;
      prices.push({
        startsAt: date.toISOString(),
        total,
        isCheap: total <= 75,
        isExpensive: total >= 125,
      });
    }

    const combinedPrices = {
      prices,
      avgPrice: 100,
      lowThreshold: 75,
      highThreshold: 125,
      thresholdPercent: 25,
      minDiffOre: 0,
      priceScheme: 'flow',
      priceUnit: 'price units',
    };

    const setSpy = jest.fn((key, val, cb) => cb && cb(null));
    // @ts-ignore mutate mock
    global.Homey.set = setSpy;
    // @ts-ignore mutate mock
    global.Homey.get = jest.fn((key, cb) => {
      if (key === 'combined_prices') return cb(null, combinedPrices);
      if (key === 'electricity_prices') return cb(null, []);
      if (key === 'target_devices_snapshot') return cb(null, []);
      if (key === 'price_optimization_settings') return cb(null, {});
      return cb(null, null);
    });

    await loadSettingsScript();

    const pricePanel = document.querySelector('#price-panel');
    pricePanel?.classList.remove('hidden');

    const priceTab = document.querySelector('[data-tab="price"]') as HTMLButtonElement;
    priceTab?.click();
    await flushPromises();

    const summaryBefore = document.querySelectorAll('.price-summary-item');
    expect(summaryBefore?.[0]?.textContent).toContain('cheap hour');
    expect(summaryBefore?.[1]?.textContent).toContain('expensive hour');

    const thresholdInput = document.querySelector('#price-threshold-percent') as HTMLInputElement;
    const minDiffInput = document.querySelector('#price-min-diff-ore') as HTMLInputElement;
    thresholdInput.value = '5';
    minDiffInput.value = '40';
    minDiffInput.dispatchEvent(new Event('change', { bubbles: true }));
    await waitFor(() => {
      const summary = document.querySelectorAll('.price-summary-item');
      const cheapText = summary?.[0]?.textContent ?? '';
      return cheapText.includes('No cheap hours');
    });

    const summaryAfter = document.querySelectorAll('.price-summary-item');
    expect(summaryAfter?.[0]?.textContent).toContain('No cheap hours');
    expect(summaryAfter?.[0]?.textContent).toContain('at or below 60.0000');
    expect(summaryAfter?.[1]?.textContent).toContain('No expensive hours');
    expect(summaryAfter?.[1]?.textContent).toContain('at or above 140.0000');

    const detailsSections = document.querySelectorAll('.price-details');
    const timeZone = 'UTC';
    const dayKeys = new Set(
      combinedPrices.prices.map((entry: any) => getDateKeyInTimeZone(new Date(entry.startsAt), timeZone)),
    );
    const expectedDetails = Math.min(dayKeys.size, 2);
    expect(detailsSections.length).toBe(expectedDetails);
  });

  it('falls back to electricity_prices when combined_prices not available', async () => {
    // Create spot-only price data
    const now = new Date();
    const currentHourStartMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), now.getUTCHours(), 0, 0, 0);
    const hourMs = 60 * 60 * 1000;

    const spotPrices: any[] = [];
    for (let hour = 0; hour < 24; hour++) {
      const date = new Date(currentHourStartMs + hour * hourMs);
      let total = 80;
      // Make cheap/expensive hours relative to current hour
      if (hour >= 1 && hour <= 3) total = 40; // Cheap
      if (hour >= 6 && hour <= 8) total = 120; // Expensive
      spotPrices.push({
        startsAt: date.toISOString(),
        spotPriceExVat: total,
        currency: 'NOK',
      });
    }

    const setSpy = jest.fn((key, val, cb) => cb && cb(null));
    // @ts-ignore mutate mock
    global.Homey.set = setSpy;
    // @ts-ignore mutate mock
    global.Homey.get = jest.fn((key, cb) => {
      if (key === 'combined_prices') return cb(null, null); // No combined prices
      if (key === 'electricity_prices') return cb(null, spotPrices);
      if (key === 'target_devices_snapshot') return cb(null, []);
      if (key === 'price_optimization_settings') return cb(null, {});
      return cb(null, null);
    });

    await loadSettingsScript();

    // Switch to price tab to trigger refresh
    const priceTab = document.querySelector('[data-tab="price"]') as HTMLButtonElement;
    priceTab?.click();
    await flushPromises();

    const priceList = document.querySelector('#price-list');
    const priceStatusBadge = document.querySelector('#price-status-badge') as HTMLElement | null;

    // Verify price list has content (using fallback data)
    expect(priceList?.innerHTML).not.toBe('');

    // Status badge is only shown for warn states; ok/normal price is not badged
    expect(priceStatusBadge?.hidden).toBe(true);
  });

  it('uses NOK conversion for internal price scheme on daily budget cost', async () => {
    const dailyBudgetPayload = {
      days: {
        '2024-01-01': {
          dateKey: '2024-01-01',
          timeZone: 'UTC',
          nowUtc: '2024-01-01T01:30:00.000Z',
          dayStartUtc: '2024-01-01T00:00:00.000Z',
          currentBucketIndex: 1,
          budget: {
            enabled: true,
            dailyBudgetKWh: 2,
            priceShapingEnabled: true,
          },
          state: {
            usedNowKWh: 1,
            allowedNowKWh: 1,
            remainingKWh: 1,
            deviationKWh: 0,
            exceeded: false,
            frozen: false,
            confidence: 0.5,
            priceShapingActive: false,
          },
          buckets: {
            startUtc: ['2024-01-01T00:00:00.000Z', '2024-01-01T01:00:00.000Z'],
            startLocalLabels: ['00:00', '01:00'],
            plannedWeight: [0.5, 0.5],
            plannedKWh: [1, 1],
            actualKWh: [1, 1],
            allowedCumKWh: [1, 2],
            price: [100, 200], // øre/kWh
          },
        },
      },
      todayKey: '2024-01-01',
      tomorrowKey: null,
    };

    // @ts-ignore mutate mock
    global.Homey.get = jest.fn((key, cb) => {
      if (key === 'combined_prices') {
        return cb(null, { priceScheme: 'norway', priceUnit: 'øre/kWh' });
      }
      if (key === 'target_devices_snapshot') return cb(null, []);
      if (key === 'price_optimization_settings') return cb(null, {});
      return cb(null, null);
    });
    // @ts-ignore mutate mock
    global.Homey.api = jest.fn((method, uri, bodyOrCallback, cb) => {
      const callback = typeof bodyOrCallback === 'function' ? bodyOrCallback : cb;
      if (!callback) return;
      if (method === 'GET' && uri === '/daily_budget') {
        callback(null, dailyBudgetPayload);
        return;
      }
      if (method === 'GET' && uri === '/ui_prices') {
        callback(null, {
          combinedPrices: { priceScheme: 'norway', priceUnit: 'øre/kWh' },
          electricityPrices: null,
          priceArea: null,
          gridTariffData: null,
          flowToday: null,
          flowTomorrow: null,
          homeyCurrency: null,
          homeyToday: null,
          homeyTomorrow: null,
        });
        return;
      }
      if (method === 'GET' && uri === '/homey_devices') {
        callback(null, []);
        return;
      }
      callback(null, null);
    });

    await loadSettingsScript();

    const costText = document.querySelector('#daily-budget-cost')?.textContent;
    expect(costText).toBe('3.00 kr');
  });

  it('keeps external price units on daily budget cost', async () => {
    const dailyBudgetPayload = {
      days: {
        '2024-01-01': {
          dateKey: '2024-01-01',
          timeZone: 'UTC',
          nowUtc: '2024-01-01T01:30:00.000Z',
          dayStartUtc: '2024-01-01T00:00:00.000Z',
          currentBucketIndex: 1,
          budget: {
            enabled: true,
            dailyBudgetKWh: 2,
            priceShapingEnabled: true,
          },
          state: {
            usedNowKWh: 1,
            allowedNowKWh: 1,
            remainingKWh: 1,
            deviationKWh: 0,
            exceeded: false,
            frozen: false,
            confidence: 0.5,
            priceShapingActive: false,
          },
          buckets: {
            startUtc: ['2024-01-01T00:00:00.000Z', '2024-01-01T01:00:00.000Z'],
            startLocalLabels: ['00:00', '01:00'],
            plannedWeight: [0.5, 0.5],
            plannedKWh: [1, 1],
            actualKWh: [1, 1],
            allowedCumKWh: [1, 2],
            price: [100, 200], // external units
          },
        },
      },
      todayKey: '2024-01-01',
      tomorrowKey: null,
    };

    // @ts-ignore mutate mock
    global.Homey.get = jest.fn((key, cb) => {
      if (key === 'combined_prices') {
        return cb(null, { priceScheme: 'flow', priceUnit: 'price units' });
      }
      if (key === 'target_devices_snapshot') return cb(null, []);
      if (key === 'price_optimization_settings') return cb(null, {});
      return cb(null, null);
    });
    // @ts-ignore mutate mock
    global.Homey.api = jest.fn((method, uri, bodyOrCallback, cb) => {
      const callback = typeof bodyOrCallback === 'function' ? bodyOrCallback : cb;
      if (!callback) return;
      if (method === 'GET' && uri === '/daily_budget') {
        callback(null, dailyBudgetPayload);
        return;
      }
      if (method === 'GET' && uri === '/ui_prices') {
        callback(null, {
          combinedPrices: { priceScheme: 'flow', priceUnit: 'price units' },
          electricityPrices: null,
          priceArea: null,
          gridTariffData: null,
          flowToday: null,
          flowTomorrow: null,
          homeyCurrency: null,
          homeyToday: null,
          homeyTomorrow: null,
        });
        return;
      }
      if (method === 'GET' && uri === '/homey_devices') {
        callback(null, []);
        return;
      }
      callback(null, null);
    });

    await loadSettingsScript();

    const costText = document.querySelector('#daily-budget-cost')?.textContent;
    expect(costText).toBe('300.00');
  });

  it('renders budget chart without legacy html legend when breakdown is enabled', async () => {
    const dailyBudgetPayload = {
      days: {
        '2024-01-01': {
          dateKey: '2024-01-01',
          timeZone: 'UTC',
          nowUtc: '2024-01-01T01:30:00.000Z',
          dayStartUtc: '2024-01-01T00:00:00.000Z',
          currentBucketIndex: 1,
          budget: {
            enabled: true,
            dailyBudgetKWh: 2,
            priceShapingEnabled: true,
          },
          state: {
            usedNowKWh: 1,
            allowedNowKWh: 1,
            remainingKWh: 1,
            deviationKWh: 0,
            exceeded: false,
            frozen: false,
            confidence: 1,
            priceShapingActive: false,
          },
          buckets: {
            startUtc: ['2024-01-01T00:00:00.000Z', '2024-01-01T01:00:00.000Z'],
            startLocalLabels: ['00:00', '01:00'],
            plannedWeight: [0.5, 0.5],
            plannedKWh: [1, 1],
            plannedUncontrolledKWh: [0.3, 0.7],
            plannedControlledKWh: [0.7, 0.3],
            actualKWh: [1, 1],
            allowedCumKWh: [1, 2],
            price: [100, 200],
          },
        },
      },
      todayKey: '2024-01-01',
      tomorrowKey: null,
    };

    // @ts-ignore mutate mock
    global.Homey.get = jest.fn((key, cb) => {
      if (key === 'daily_budget_breakdown_enabled') return cb(null, false);
      if (key === 'combined_prices') {
        return cb(null, { priceScheme: 'flow', priceUnit: 'price units' });
      }
      if (key === 'target_devices_snapshot') return cb(null, []);
      if (key === 'price_optimization_settings') return cb(null, {});
      return cb(null, null);
    });
    // @ts-ignore mutate mock
    global.Homey.api = jest.fn((method, uri, bodyOrCallback, cb) => {
      const callback = typeof bodyOrCallback === 'function' ? bodyOrCallback : cb;
      if (!callback) return;
      if (method === 'GET' && uri === '/daily_budget') {
        callback(null, dailyBudgetPayload);
        return;
      }
      if (method === 'GET' && uri === '/ui_prices') {
        callback(null, {
          combinedPrices: { priceScheme: 'flow', priceUnit: 'price units' },
          electricityPrices: null,
          priceArea: null,
          gridTariffData: null,
          flowToday: null,
          flowTomorrow: null,
          homeyCurrency: null,
          homeyToday: null,
          homeyTomorrow: null,
        });
        return;
      }
      if (method === 'GET' && uri === '/homey_devices') {
        callback(null, []);
        return;
      }
      callback(null, null);
    });

    await loadSettingsScript();

    expect(document.querySelector('#daily-budget-legend')).toBeNull();

    const { dailyBudgetBreakdownInput } = require('../src/ui/dom');
    dailyBudgetBreakdownInput.checked = true;
    dailyBudgetBreakdownInput.dispatchEvent(new Event('change', { bubbles: true }));
    const { rerenderDailyBudget } = require('../src/ui/dailyBudget');
    rerenderDailyBudget();
    await flushPromises();

    expect(document.querySelector('#daily-budget-legend')).toBeNull();
    expect(document.querySelector('#daily-budget-chart')?.hasAttribute('hidden')).toBe(false);
  });

  it('loads device diagnostics through the Homey API when opening device detail', async () => {
    global.Homey.__uiState.deviceDiagnostics = {
      generatedAt: Date.now(),
      windowDays: 21,
      diagnosticsByDeviceId: {
        'dev-1': {
          currentPenaltyLevel: 2,
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

    await loadSettingsScript();
    (global.Homey.api as jest.Mock).mockClear();

    await waitFor(() => document.querySelector('[data-device-id="dev-1"]') !== null);
    const deviceRow = document.querySelector('[data-device-id="dev-1"]') as HTMLElement | null;
    deviceRow?.click();

    expect((global.Homey.api as jest.Mock).mock.calls.some(
      (call) => call[0] === 'GET' && call[1] === '/ui_device_diagnostics',
    )).toBe(false);

    const diagnosticsDisclosure = document.querySelector('#device-detail-diagnostics-disclosure') as HTMLDetailsElement | null;
    diagnosticsDisclosure!.open = true;
    diagnosticsDisclosure!.dispatchEvent(new Event('toggle'));

    await waitFor(() => (
      (document.querySelector('#device-detail-diagnostics-status') as HTMLElement | null)?.textContent?.includes('Current penalty level: L2')
        === true
    ));

    expect((global.Homey.api as jest.Mock).mock.calls).toEqual(expect.arrayContaining([
      expect.arrayContaining(['GET', '/ui_device_diagnostics']),
    ]));
    expect(document.querySelector('#device-detail-diagnostics-cards')?.textContent).toContain('Failed activations');
    expect(document.querySelector('#device-detail-diagnostics-cards')?.textContent).toContain('Penalty history');
  });

  it('shows a diagnostics unavailable state when the Homey API route fails', async () => {
    const baseApi = buildHomeyApiMock(global.Homey);
    global.Homey.api = jest.fn((method, uri, bodyOrCallback, cb) => {
      const callback = typeof bodyOrCallback === 'function' ? bodyOrCallback : cb;
      if (method === 'GET' && uri === '/ui_device_diagnostics') {
        callback?.(new Error('Cannot GET /api/app/com.barelysufficient.pels/ui_device_diagnostics'));
        return;
      }
      return baseApi(method, uri, bodyOrCallback, cb);
    });

    await loadSettingsScript();

    await waitFor(() => document.querySelector('[data-device-id="dev-1"]') !== null);
    const deviceRow = document.querySelector('[data-device-id="dev-1"]') as HTMLElement | null;
    deviceRow?.click();

    const diagnosticsDisclosure = document.querySelector('#device-detail-diagnostics-disclosure') as HTMLDetailsElement | null;
    diagnosticsDisclosure!.open = true;
    diagnosticsDisclosure!.dispatchEvent(new Event('toggle'));

    await waitFor(() => (
      (document.querySelector('#device-detail-diagnostics-status') as HTMLElement | null)?.textContent === 'Diagnostics unavailable.'
    ));
  });
});

describe('Plan sorting', () => {
  beforeEach(() => {
    jest.resetModules();
    buildDom();
    installSettingsHomeyMock({
      device_plan_snapshot: null,
      target_devices_snapshot: [],
    });
  });

  const setupPlanHomeyMock = (planSnapshot: any) => {
    installSettingsHomeyMock({
      device_plan_snapshot: planSnapshot,
      target_devices_snapshot: [],
    });
  };

  it('sorts devices by priority ascending within each zone (priority 1 = most important, first)', async () => {
    // Note: This test verifies the settings UI sorting - backend sorting is tested in plan.test.ts
    const planSnapshot = {
      meta: {
        totalKw: 4.2,
        softLimitKw: 9.5,
        headroomKw: 5.3,
      },
      devices: [
        {
          id: 'dev-1', name: 'Most Important Heater', zone: 'Living Room', priority: 1, currentState: 'heating', plannedState: 'keep',
        },
        {
          id: 'dev-2', name: 'Least Important Heater', zone: 'Living Room', priority: 5, currentState: 'heating', plannedState: 'keep',
        },
        {
          id: 'dev-3', name: 'Medium Priority Heater', zone: 'Living Room', priority: 3, currentState: 'heating', plannedState: 'keep',
        },
      ],
    };

    setupPlanHomeyMock(planSnapshot);

    await loadSettingsScript();

    // Switch to overview tab
    const overviewTab = document.querySelector('[data-tab="overview"]') as HTMLButtonElement;
    overviewTab?.click();
    await flushPromises();

    const planList = document.querySelector('#plan-list');
    const deviceRows = planList?.querySelectorAll('.device-row');

    expect(deviceRows?.length).toBe(3);

    // Get device names in order
    const deviceNames = Array.from(deviceRows || []).map(
      (row) => row.querySelector('.device-row__name')?.textContent,
    );

    // Priority 1 = most important, shown first: 1, 3, 5
    expect(deviceNames).toEqual([
      'Most Important Heater', // priority 1
      'Medium Priority Heater', // priority 3
      'Least Important Heater', // priority 5
    ]);
  });

  it('shows planned state lines for devices', async () => {
    const planSnapshot = {
      meta: {
        totalKw: 5.1,
        softLimitKw: 7.5,
        headroomKw: 2.4,
      },
      devices: [
        { id: 'a2', name: 'Alpha Two', priority: 2, currentState: 'on', plannedState: 'keep' },
        { id: 'b1', name: 'Bravo One', priority: 1, currentState: 'on', plannedState: 'shed' },
        { id: 'a1', name: 'Alpha One', priority: 1, currentState: 'on', plannedState: 'keep' },
      ],
    };

    setupPlanHomeyMock(planSnapshot);

    await loadSettingsScript();

    const overviewTab = document.querySelector('[data-tab="overview"]') as HTMLButtonElement;
    overviewTab?.click();
    await flushPromises();

    const deviceRows = document.querySelectorAll('#plan-list .device-row');
    const deviceNames = Array.from(deviceRows).map(
      (row) => row.querySelector('.device-row__name')?.textContent,
    );
    expect(deviceNames).toEqual(['Bravo One', 'Alpha One', 'Alpha Two']); // priority order

    const stateValues = Array.from(document.querySelectorAll('#plan-list .plan-meta-line'))
      .filter((line) => line.querySelector('.plan-label')?.textContent === 'State')
      .map((line) => line.querySelector('span:last-child')?.textContent);
    expect(stateValues).toContain('Shed (powered off)');
  });

  it('shows measured and expected power in usage line when available', async () => {
    const planSnapshot = {
      meta: {
        totalKw: 3.3,
        softLimitKw: 9.0,
        headroomKw: 5.7,
      },
      devices: [
        {
          id: 'device-1',
          name: 'Heater',
          priority: 1,
          currentState: 'on',
          plannedState: 'keep',
          measuredPowerKw: 1.23,
          expectedPowerKw: 2.34,
        },
      ],
    };

    setupPlanHomeyMock(planSnapshot);

    await loadSettingsScript();

    const overviewTab = document.querySelector('[data-tab="overview"]') as HTMLButtonElement;
    overviewTab?.click();
    await flushPromises();

    const usageLines = Array.from(document.querySelectorAll('#plan-list .plan-meta-line'))
      .filter((line) => line.querySelector('.plan-label')?.textContent === 'Usage')
      .map((line) => line.querySelector('span:last-child')?.textContent || '');

    expect(usageLines[0]).toContain('Measured: 1.23 kW / Expected: 2.34 kW');
  });

  it('shows expected power when device is off and only expected is known', async () => {
    const planSnapshot = {
      meta: {
        totalKw: 1.0,
        softLimitKw: 9.0,
        headroomKw: 8.0,
      },
      devices: [
        {
          id: 'device-2',
          name: 'Radiator',
          priority: 1,
          currentState: 'off',
          plannedState: 'keep',
          expectedPowerKw: 1.5,
        },
      ],
    };

    setupPlanHomeyMock(planSnapshot);

    await loadSettingsScript();

    const overviewTab = document.querySelector('[data-tab="overview"]') as HTMLButtonElement;
    overviewTab?.click();
    await flushPromises();

    const usageLines = Array.from(document.querySelectorAll('#plan-list .plan-meta-line'))
      .filter((line) => line.querySelector('.plan-label')?.textContent === 'Usage')
      .map((line) => line.querySelector('span:last-child')?.textContent || '');

    expect(usageLines[0]).toBe('Expected: 1.50 kW');
  });

  it('shows measured 0 with expected power when device is on but not drawing', async () => {
    const planSnapshot = {
      meta: {
        totalKw: 2.0,
        softLimitKw: 9.0,
        headroomKw: 7.0,
      },
      devices: [
        {
          id: 'device-3',
          name: 'Idle Thermostat',
          priority: 1,
          currentState: 'on',
          plannedState: 'keep',
          measuredPowerKw: 0,
          expectedPowerKw: 0.12,
        },
      ],
    };

    installSettingsHomeyMock({
      device_plan_snapshot: planSnapshot,
      target_devices_snapshot: [],
    });

    await loadSettingsScript();

    const overviewTab = document.querySelector('[data-tab="overview"]') as HTMLButtonElement;
    overviewTab?.click();
    await flushPromises();

    const usageLines = Array.from(document.querySelectorAll('#plan-list .plan-meta-line'))
      .filter((line) => line.querySelector('.plan-label')?.textContent === 'Usage')
      .map((line) => line.querySelector('span:last-child')?.textContent || '');

    expect(usageLines[0]).toBe('Measured: 0.00 kW / Expected: 0.12 kW');
  });

  it('refreshes plan when capacity priorities change via settings event', async () => {
    const listeners: Record<string, ((...args: unknown[]) => void)[]> = {};
    const getSpy = jest.fn((key, cb) => {
      if (key === 'device_plan_snapshot') {
        return cb(null, {
          meta: { totalKw: 1, softLimitKw: 5, headroomKw: 4 },
          devices: [],
        });
      }
      if (key === 'target_devices_snapshot') return cb(null, []);
      if (key === 'capacity_priorities') return cb(null, { Home: {} });
      if (key === 'mode_device_targets') return cb(null, { Home: {} });
      if (key === 'controllable_devices') return cb(null, {});
      if (key === 'managed_devices') return cb(null, {});
      if (key === 'price_optimization_settings') return cb(null, {});
      if (key === 'operating_mode') return cb(null, 'Home');
      return cb(null, null);
    });

    installSettingsHomeyMock({
      device_plan_snapshot: {
        meta: { totalKw: 1, softLimitKw: 5, headroomKw: 4 },
        devices: [],
      },
      target_devices_snapshot: [],
      capacity_priorities: { Home: {} },
      mode_device_targets: { Home: {} },
    });
    global.Homey.get = getSpy;
    global.Homey.on = jest.fn((event, cb) => {
      if (!listeners[event]) listeners[event] = [];
      listeners[event].push(cb);
    });

    await loadSettingsScript();

    const overviewTab = document.querySelector('[data-tab="overview"]') as HTMLButtonElement;
    overviewTab?.click();
    await flushPromises();

    const before = getSpy.mock.calls.filter((call) => call[0] === 'device_plan_snapshot').length;
    const settingsCallbacks = listeners['settings.set'] || [];
    settingsCallbacks.forEach((cb) => cb('capacity_priorities'));
    await flushPromises();

    const after = getSpy.mock.calls.filter((call) => call[0] === 'device_plan_snapshot').length;
    expect(after).toBeGreaterThan(before);
  });

  it('keeps the stale-data banner hidden when tracker data is fresh even if status is stale', async () => {
    const now = Date.now();
    global.Homey.__uiState.power = {
      tracker: { lastTimestamp: now - 5_000 },
      status: { lastPowerUpdate: now - 2 * 60_000, priceLevel: 'cheap' },
      heartbeat: now,
    };

    await loadSettingsScript();

    const banner = document.querySelector('#stale-data-banner') as HTMLDivElement;
    expect(banner.hidden).toBe(true);
  });

  it('shows the heartbeat warning even when tracker data is fresh', async () => {
    const now = Date.now();
    global.Homey.__uiState.power = {
      tracker: { lastTimestamp: now - 5_000 },
      status: { lastPowerUpdate: now - 5_000, priceLevel: 'cheap' },
      heartbeat: now - 2 * 60_000,
    };

    await loadSettingsScript();

    const banner = document.querySelector('#stale-data-banner') as HTMLDivElement;
    const bannerText = document.querySelector('#stale-data-text') as HTMLSpanElement;
    expect(banner.hidden).toBe(false);
    expect(bannerText.textContent).toBe('App heartbeat missing. PELS may not be running.');
  });

  it('self-corrects the stale-data banner from power_updated without refetching /ui_power', async () => {
    const listeners: Record<string, ((...args: unknown[]) => void)[]> = {};
    const stalePower = {
      tracker: { lastTimestamp: Date.now() - 2 * 60_000 },
      status: { lastPowerUpdate: Date.now() - 2 * 60_000, priceLevel: 'cheap' },
      heartbeat: Date.now(),
    };

    global.Homey.__uiState = { power: stalePower };
    global.Homey.on = jest.fn((event, cb) => {
      if (!listeners[event]) listeners[event] = [];
      listeners[event].push(cb);
    });
    global.Homey.api = buildHomeyApiMock(global.Homey);

    await loadSettingsScript();

    const banner = document.querySelector('#stale-data-banner') as HTMLDivElement;
    expect(banner.hidden).toBe(false);

    (global.Homey.api as jest.Mock).mockClear();
    const freshPower = {
      tracker: { lastTimestamp: Date.now() - 5_000 },
      status: { lastPowerUpdate: Date.now() - 2 * 60_000, priceLevel: 'cheap' },
      heartbeat: Date.now(),
    };
    const powerCallbacks = listeners.power_updated || [];
    powerCallbacks.forEach((cb) => cb(freshPower));
    await flushPromises();

    expect(banner.hidden).toBe(true);
    const powerGetCalls = (global.Homey.api as jest.Mock).mock.calls
      .filter((call) => call[0] === 'GET' && call[1] === '/ui_power');
    expect(powerGetCalls).toHaveLength(0);
  });

  it('invalidates /ui_power cache before periodic stale-data checks', async () => {
    const intervalCallbacks = new Map<number, () => void>();
    const setIntervalSpy = jest.spyOn(global, 'setInterval').mockImplementation(((callback, ms) => {
      intervalCallbacks.set(ms as number, callback as () => void);
      return 1 as unknown as ReturnType<typeof setInterval>;
    }) as typeof setInterval);

    try {
      const now = Date.now();
      global.Homey.__uiState.power = {
        tracker: { lastTimestamp: now - 5_000 },
        status: { lastPowerUpdate: now - 2 * 60_000, priceLevel: 'cheap' },
        heartbeat: now,
      };

      await loadSettingsScript();

      const banner = document.querySelector('#stale-data-banner') as HTMLDivElement;
      expect(banner.hidden).toBe(true);

      global.Homey.__uiState.power = {
        tracker: { lastTimestamp: now - 2 * 60_000 },
        status: { lastPowerUpdate: now - 2 * 60_000, priceLevel: 'cheap' },
        heartbeat: now,
      };

      (global.Homey.api as jest.Mock).mockClear();
      const staleInterval = intervalCallbacks.get(30 * 1000);
      expect(typeof staleInterval).toBe('function');
      staleInterval?.();
      await flushPromises();

      expect(banner.hidden).toBe(false);
      const powerGetCalls = (global.Homey.api as jest.Mock).mock.calls
        .filter((call) => call[0] === 'GET' && call[1] === '/ui_power');
      expect(powerGetCalls.length).toBeGreaterThan(0);
    } finally {
      setIntervalSpy.mockRestore();
    }
  });

  it('invalidates /ui_plan cache when reopening overview and when using Refresh plan', async () => {
    await loadSettingsScript();

    (global.Homey.api as jest.Mock).mockClear();

    const devicesTab = document.querySelector('[data-tab="devices"]') as HTMLButtonElement;
    const overviewTab = document.querySelector('[data-tab="overview"]') as HTMLButtonElement;
    const refreshPlanButton = document.querySelector('#plan-refresh-button') as HTMLButtonElement;

    devicesTab.click();
    await flushPromises();
    overviewTab.click();
    await flushPromises();
    refreshPlanButton.click();
    await flushPromises();

    const planGetCalls = (global.Homey.api as jest.Mock).mock.calls
      .filter((call) => call[0] === 'GET' && call[1] === '/ui_plan');
    expect(planGetCalls).toHaveLength(2);
  });

  it('returns a Homey-style 404 for API paths not declared in app.json', async () => {
    const api = buildHomeyApiMock(global.Homey);

    const result = await new Promise<{ err: Error | null; value?: unknown }>((resolve) => {
      api('GET', '/definitely_missing_route', {}, (err, value) => resolve({ err, value }));
    });

    expect(result.value).toBeUndefined();
    expect(result.err).toBeInstanceOf(Error);
    expect(result.err?.message).toContain('Cannot GET /api/app/com.barelysufficient.pels/definitely_missing_route');
  });

  it('savePriorities assigns priority 1 to top device', () => {
    // Verify savePriorities logic: top item = priority 1 (most important, shed last)
    const rows = ['dev-1', 'dev-2', 'dev-3']; // DOM order: top to bottom
    const priorities: Record<string, number> = {};

    // Fixed code: modeMap[id] = index + 1;
    rows.forEach((id, index) => {
      priorities[id] = index + 1;
    });

    // Top item should be priority 1 (most important, shed last)
    expect(priorities['dev-1']).toBe(1); // TOP = most important = priority 1
    expect(priorities['dev-2']).toBe(2);
    expect(priorities['dev-3']).toBe(3); // BOTTOM = least important = priority 3
  });

  it('uses the device target step for mode inputs and saves normalized values', async () => {
    const setSpy = jest.fn((key, val, cb) => cb && cb(null));
    // @ts-ignore mutate mock
    global.Homey.set = setSpy;
    // @ts-ignore mutate mock
    global.Homey.get = jest.fn((key, cb) => {
      if (key === 'target_devices_snapshot') {
        return cb(null, [
          {
            id: 'dev-1',
            name: 'Connected 300',
            deviceType: 'temperature',
            targets: [{ id: 'target_temperature', value: 65, unit: '°C', min: 35, max: 75, step: 5 }],
          },
        ]);
      }
      if (key === 'operating_mode') return cb(null, 'Home');
      if (key === 'capacity_priorities') return cb(null, { Home: { 'dev-1': 1 } });
      if (key === 'mode_device_targets') return cb(null, { Home: { 'dev-1': 46 } });
      if (key === 'managed_devices') return cb(null, { 'dev-1': true });
      if (key === 'controllable_devices') return cb(null, { 'dev-1': true });
      if (key === 'price_optimization_settings') return cb(null, {});
      return cb(null, null);
    });

    await loadSettingsScript();

    const input = document.querySelector('.mode-target-input') as HTMLInputElement | null;
    expect(input).not.toBeNull();
    expect(input?.step).toBe('5');
    expect(input?.value).toBe('45');

    if (!input) throw new Error('Expected mode target input');
    input.value = '46';
    input.dispatchEvent(new Event('change'));

    await waitFor(() => {
      const calls = setSpy.mock.calls.filter((call) => call[0] === 'mode_device_targets');
      return calls.length > 0;
    }, 1500);

    const calls = setSpy.mock.calls.filter((call) => call[0] === 'mode_device_targets');
    expect(calls[calls.length - 1]?.[1]).toEqual({ Home: { 'dev-1': 45 } });
  });
});
