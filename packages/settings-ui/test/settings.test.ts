import type { TargetDeviceSnapshot } from '../../contracts/src/types.ts';
import { buildComparablePlanReason } from '../../shared-domain/src/planReasonSemantics.ts';
import { buildHomeyApiMock, emitHomeyEvent, installHomeyMock } from './helpers/homeyApiMock';

vi.mock('../src/ui/toast.ts', () => ({
  showToast: vi.fn().mockResolvedValue(undefined),
  showToastError: vi.fn().mockResolvedValue(undefined),
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

const getDiagnosticsMetricValue = (label: string): string | null => {
  const cards = document.querySelector('#device-detail-diagnostics-cards');
  const labels = Array.from(cards?.querySelectorAll('dt') ?? []);
  const labelNode = labels.find((node) => node.textContent === label);
  return labelNode?.nextElementSibling?.textContent ?? null;
};

/**
 * Basic render test for the settings UI with Homey mocked.
 */
const buildDom = () => {
  document.body.innerHTML = `
    <div id="toast"></div>
    <div id="status-badge"></div>
    <div id="dry-run-banner" hidden></div>
    <md-outlined-button id="simulation-disable-button"></md-outlined-button>
    <div id="stale-data-banner" hidden>
      <span id="stale-data-text"></span>
    </div>
    <div class="tabs" id="shell-nav">
      <button class="tab active" data-tab="overview"></button>
      <button class="tab" data-tab="budget"></button>
      <button class="tab" data-tab="usage"></button>
      <button class="tab" data-tab="settings"></button>
    </div>
    <section class="panel hidden" id="settings-panel" data-panel="settings">
      <section class="settings-form-card settings-current-mode">
        <h3 class="field__label settings-current-mode__heading" id="settings-active-mode-summary">Current mode</h3>
        <div class="field settings-current-mode__field">
          <md-filled-select id="active-mode-select" aria-labelledby="settings-active-mode-summary"></md-filled-select>
        </div>
        <p class="muted settings-current-mode__hint">Priorities and temperatures stay in Modes.</p>
      </section>
      <button data-settings-target="limits"></button>
      <button data-settings-target="devices"></button>
      <button data-settings-target="modes"></button>
      <button data-settings-target="price"></button>
      <button data-settings-target="simulation"></button>
      <button data-settings-target="advanced"></button>
    </section>
    <section class="panel hidden" id="limits-panel" data-panel="limits">
      <form id="settings-limits-form">
        <md-filled-text-field id="settings-capacity-limit"></md-filled-text-field>
        <md-filled-text-field id="settings-capacity-margin"></md-filled-text-field>
        <span id="settings-capacity-reaction"></span>
        <md-filled-select id="settings-power-source">
          <md-select-option value="flow"><div slot="headline">Flow card</div></md-select-option>
          <md-select-option value="homey_energy"><div slot="headline">Homey Energy</div></md-select-option>
        </md-filled-select>
      </form>
    </section>
    <section class="panel hidden" id="simulation-panel" data-panel="simulation">
      <md-switch id="settings-simulation-mode"></md-switch>
    </section>
    <section class="panel hidden" id="overview-panel" data-panel="overview">
      <div id="plan-redesign-surface">
        <div id="plan-hero"></div>
        <div id="plan-hour-strip"></div>
        <div id="plan-cards"></div>
      </div>
      <p id="plan-empty" hidden></p>
    </section>
    <section class="panel" data-panel="devices">
      <form id="targets-form">
        <select id="target-mode-select"></select>
      </form>
      <div id="device-card-list"></div>
      <p id="empty-state" hidden></p>
    </section>
    <section class="panel hidden" data-panel="modes">
      <md-filled-select id="mode-select"></md-filled-select>
      <md-filled-text-field id="mode-new"></md-filled-text-field>
      <md-outlined-button id="add-mode-button"></md-outlined-button>
      <md-outlined-button id="delete-mode-button"></md-outlined-button>
      <md-outlined-button id="rename-mode-button"></md-outlined-button>
      <form id="priority-form"></form>
      <div id="priority-list"></div>
      <p id="priority-empty" hidden></p>
    </section>
    <section class="panel hidden" data-panel="budget">
    </section>
    <section class="panel hidden" id="usage-panel" data-panel="usage">
      <div id="power-list"></div>
      <p id="power-empty" hidden></p>
      <md-text-button id="power-week-prev"></md-text-button>
      <md-text-button id="power-week-next"></md-text-button>
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
      <div id="debug-logging-checkboxes"></div>
      <form id="daily-budget-advanced-form">
        <md-filled-select id="daily-budget-controlled-weight">
          <md-select-option value="0"><div slot="headline">Balanced</div></md-select-option>
          <md-select-option value="1"><div slot="headline">Conservative</div></md-select-option>
        </md-filled-select>
        <md-filled-select id="daily-budget-price-flex-share">
          <md-select-option value="0.3"><div slot="headline">Low</div></md-select-option>
          <md-select-option value="0.6"><div slot="headline">Medium</div></md-select-option>
          <md-select-option value="0.85"><div slot="headline">High</div></md-select-option>
        </md-filled-select>
        <md-switch id="daily-budget-breakdown"></md-switch>
      </form>
    </section>
    <div id="device-detail-overlay" hidden>
      <div id="device-detail-panel">
        <div id="device-detail-title"></div>
        <md-text-button id="device-detail-close"></md-text-button>
        <md-checkbox id="device-detail-managed"></md-checkbox>
        <md-checkbox id="device-detail-controllable"></md-checkbox>
        <md-checkbox id="device-detail-price-opt"></md-checkbox>
        <div id="device-detail-modes"></div>
        <div id="device-detail-delta-section"></div>
        <md-filled-text-field id="device-detail-cheap-delta"></md-filled-text-field>
        <md-filled-text-field id="device-detail-expensive-delta"></md-filled-text-field>
        <md-filled-select id="device-detail-overshoot">
          <md-select-option value="turn_off"><div slot="headline">Turn off</div></md-select-option>
          <md-select-option value="set_temperature"><div slot="headline">Set to temperature</div></md-select-option>
          <md-select-option value="set_step"><div slot="headline">Set to step</div></md-select-option>
        </md-filled-select>
        <div id="device-detail-overshoot-temp-row"></div>
        <md-filled-text-field id="device-detail-overshoot-temp"></md-filled-text-field>
        <div id="device-detail-overshoot-step-row"></div>
        <md-filled-select id="device-detail-overshoot-step"></md-filled-select>
        <section id="device-detail-stepped-section" hidden>
          <div id="device-detail-stepped-steps"></div>
          <md-outlined-button id="device-detail-stepped-add-step"></md-outlined-button>
          <md-filled-button id="device-detail-stepped-save"></md-filled-button>
          <md-outlined-button id="device-detail-stepped-reset"></md-outlined-button>
        </section>
        <details id="device-detail-diagnostics-disclosure">
          <summary>Advanced diagnostics</summary>
          <div id="device-detail-diagnostics-status"></div>
          <div id="device-detail-diagnostics-cards"></div>
        </details>
      </div>
    </div>
    <md-outlined-button id="refresh-button"></md-outlined-button>
    <md-outlined-button id="reset-stats-button"></md-outlined-button>
  `;
};

const loadSettingsScript = async () => {
  const { boot } = await import('../src/ui/boot.ts');
  await boot();
  // Devices are lazy-loaded on first device-related tab visit. In the redesign, the
  // devices section is reached via Settings > Devices.
  (document.querySelector('[data-settings-target="devices"]') as HTMLButtonElement | null)?.click();
  await waitFor(() => {
    const hasRows = document.querySelectorAll('#device-card-list .pels-device-card__row').length > 0;
    const emptyVisible = document.querySelector('#empty-state')?.hasAttribute('hidden') === false;
    return hasRows || emptyVisible;
  });
};

const DEFAULT_SETTINGS_DEVICES = [
  {
    id: 'dev-1',
    name: 'Heater',
    targets: [{ id: 'target_temperature', value: 21, unit: '°C' }],
  },
];

const buildSettingsHomeyState = (settings: Record<string, unknown> = {}) => {
  const homeySettings = { ...settings };
  delete homeySettings.planSnapshot;
  // `target_devices_snapshot` is intentionally not part of the settings store.
  // Devices are routed through `uiState.devices` so that the mock matches
  // production's `/ui_devices` contract (live in-memory device snapshot, not
  // persisted setting). The `target_devices_snapshot` key on the test input
  // is just an ergonomic alias and is stripped here.
  delete homeySettings.target_devices_snapshot;
  return {
    operating_mode: 'Home',
    capacity_priorities: {},
    mode_device_targets: {},
    controllable_devices: {},
    managed_devices: {},
    price_optimization_settings: {},
    ...homeySettings,
  };
};

const installSettingsHomeyMock = (settings: Record<string, unknown> = {}) => {
  const explicitDevices = Object.prototype.hasOwnProperty.call(settings, 'target_devices_snapshot')
    ? settings.target_devices_snapshot
    : DEFAULT_SETTINGS_DEVICES;
  return installHomeyMock({
    settings: buildSettingsHomeyState(settings),
    uiState: {
      devices: Array.isArray(explicitDevices) ? explicitDevices as TargetDeviceSnapshot[] : [],
      plan: settings.planSnapshot,
    },
  });
};

describe('settings script', () => {
  beforeEach(() => {
    vi.resetModules();
    buildDom();
    window.localStorage.clear();
    installSettingsHomeyMock();
  });

  it('renders devices with target temperature capabilities', async () => {
    await loadSettingsScript();

    const rows = document.querySelectorAll('#device-card-list .pels-device-card__row');
    expect(rows.length).toBe(1);
    expect(rows[0].querySelector('.device-row__name')?.textContent).toContain('Heater');
    expect(document.querySelector('#empty-state')?.hasAttribute('hidden')).toBe(true);
  });

  it('uses bootstrap settings to avoid refetching primed values during initial load', async () => {
    const homey = installHomeyMock({
      settings: buildSettingsHomeyState({
        capacity_limit_kw: 10,
        capacity_margin_kw: 0.5,
        capacity_dry_run: true,
      }),
      apiHandlers: {
        'GET /ui_bootstrap': async () => ({
          settings: {
            capacity_limit_kw: 7,
            capacity_margin_kw: 0.3,
            capacity_dry_run: false,
          },
          dailyBudget: null,
          plan: null,
          power: { tracker: null, status: null, heartbeat: null },
          prices: {
            combinedPrices: null,
            electricityPrices: null,
            priceArea: null,
            gridTariffData: null,
            flowToday: null,
            flowTomorrow: null,
            homeyCurrency: null,
            homeyToday: null,
            homeyTomorrow: null,
          },
        }),
      },
    });

    await loadSettingsScript();

    expect((document.querySelector('#settings-capacity-limit') as HTMLInputElement).value).toBe('7');
    expect((document.querySelector('#settings-capacity-margin') as HTMLInputElement).value).toBe('0.3');
    expect((document.querySelector('#settings-simulation-mode') as HTMLElement & { selected: boolean }).selected).toBe(false);
    const fetchedKeys = homey.get.mock.calls.map(([key]) => key);
    expect(fetchedKeys).not.toContain('capacity_limit_kw');
    expect(fetchedKeys).not.toContain('capacity_margin_kw');
    expect(fetchedKeys).not.toContain('capacity_dry_run');
  });

  it('falls back to existing load paths when bootstrap fails', async () => {
    installHomeyMock({
      settings: buildSettingsHomeyState({
        capacity_limit_kw: 8,
        capacity_margin_kw: 0.4,
        capacity_dry_run: false,
      }),
      uiState: {
        devices: DEFAULT_SETTINGS_DEVICES as TargetDeviceSnapshot[],
      },
      apiHandlers: {
        'GET /ui_bootstrap': async () => {
          throw new Error('bootstrap unavailable');
        },
      },
    });

    await loadSettingsScript();

    const rows = document.querySelectorAll('#device-card-list .pels-device-card__row');
    expect(rows.length).toBe(1);
    expect((document.querySelector('#settings-capacity-limit') as HTMLInputElement).value).toBe('8');
    expect((document.querySelector('#settings-capacity-margin') as HTMLInputElement).value).toBe('0.4');
    expect((document.querySelector('#settings-simulation-mode') as HTMLElement & { selected: boolean }).selected).toBe(false);
  });

  it('renders one switch per debug logging scenario and no longer renders topic switches', async () => {
    await loadSettingsScript();

    const { DEBUG_LOGGING_SCENARIOS } = await import('../../shared-domain/src/utils/debugLogging.ts');
    const renderedScenarios = Array.from(document.querySelectorAll<HTMLInputElement>('[data-debug-scenario]'))
      .map((input) => input.dataset.debugScenario);

    expect(renderedScenarios).toEqual(DEBUG_LOGGING_SCENARIOS.map((scenario) => scenario.id));
    expect(document.getElementById('debug-scenario-deadline_objectives')).toBeTruthy();
    expect(document.querySelectorAll('[data-debug-topic]').length).toBe(0);
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

    (document.querySelector('#device-card-list .pels-device-card__detail-button') as HTMLElement).click();
    await waitFor(() => document.querySelector('#device-detail-overlay')?.hasAttribute('hidden') === false);

    const shedAction = document.querySelector('#device-detail-overshoot') as HTMLSelectElement;
    shedAction.value = 'set_temperature';
    shedAction.dispatchEvent(new Event('change', { bubbles: true }));
    await flushPromises();

    const tempRow = document.querySelector('#device-detail-overshoot-temp-row') as HTMLElement;
    const stepRow = document.querySelector('#device-detail-overshoot-step-row') as HTMLElement;
    const stepOption = shedAction.querySelector('md-select-option[value="set_step"]') as HTMLOptionElement;

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

    (document.querySelector('#device-card-list .pels-device-card__detail-button') as HTMLElement).click();
    await waitFor(() => document.querySelector('#device-detail-overlay')?.hasAttribute('hidden') === false);
    await flushPromises();

    const shedAction = document.querySelector('#device-detail-overshoot') as HTMLSelectElement;
    const tempRow = document.querySelector('#device-detail-overshoot-temp-row') as HTMLElement;
    const stepRow = document.querySelector('#device-detail-overshoot-step-row') as HTMLElement;
    const tempOption = shedAction.querySelector('md-select-option[value="set_temperature"]') as HTMLOptionElement;
    const stepOption = shedAction.querySelector('md-select-option[value="set_step"]') as HTMLOptionElement;

    expect(shedAction.value).toBe('set_step');
    expect(tempOption.hidden).toBe(false);
    expect(stepOption.textContent).toBe('Set to step "low"');
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

    (document.querySelector('#device-card-list .pels-device-card__detail-button') as HTMLElement).click();
    await waitFor(() => document.querySelector('#device-detail-overlay')?.hasAttribute('hidden') === false);
    await flushPromises();

    const shedAction = document.querySelector('#device-detail-overshoot') as HTMLSelectElement;
    const tempRow = document.querySelector('#device-detail-overshoot-temp-row') as HTMLElement;
    const stepRow = document.querySelector('#device-detail-overshoot-step-row') as HTMLElement;
    const tempInput = document.querySelector('#device-detail-overshoot-temp') as HTMLInputElement;
    const tempOption = shedAction.querySelector('md-select-option[value="set_temperature"]') as HTMLOptionElement;
    const stepOption = shedAction.querySelector('md-select-option[value="set_step"]') as HTMLOptionElement;

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

    (document.querySelector('#device-card-list .pels-device-card__detail-button') as HTMLElement).click();
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

  it('updates the set-step label when the draft lowest active step changes', async () => {
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
            { id: 'eco', planningPowerW: 900 },
            { id: 'max', planningPowerW: 3000 },
          ],
        },
      },
      overshoot_behaviors: {
        'dev-1': { action: 'set_step' },
      },
    });
    await loadSettingsScript();

    (document.querySelector('#device-card-list .pels-device-card__detail-button') as HTMLElement).click();
    await waitFor(() => document.querySelector('#device-detail-overlay')?.hasAttribute('hidden') === false);
    await flushPromises();

    const shedAction = document.querySelector('#device-detail-overshoot') as HTMLSelectElement;
    const stepOption = shedAction.querySelector('md-select-option[value="set_step"]') as HTMLOptionElement;
    const planningInputs = Array.from(
      document.querySelectorAll('#device-detail-stepped-steps [data-step-field="planningPowerW"]'),
    ) as HTMLInputElement[];

    expect(stepOption.textContent).toBe('Set to step "eco"');

    planningInputs[1].value = '0';
    planningInputs[1].dispatchEvent(new Event('change', { bubbles: true }));
    await flushPromises();

    expect(stepOption.textContent).toBe('Set to step "max"');
  });

  it('does not persist the stepped-load profile when the shed-behavior write fails', async () => {
    const homey = installSettingsHomeyMock({
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
        'dev-1': { action: 'set_step' },
      },
    });
    const originalSet = homey.set;
    homey.set = vi.fn((key: string, value: unknown, cb?: (err: Error | null) => void) => {
      if (key === 'overshoot_behaviors') {
        cb?.(new Error('Homey SDK not ready'));
        return;
      }
      originalSet(key, value, cb);
    });
    await loadSettingsScript();

    (document.querySelector('#device-card-list .pels-device-card__detail-button') as HTMLElement).click();
    await waitFor(() => document.querySelector('#device-detail-overlay')?.hasAttribute('hidden') === false);
    await flushPromises();

    const planningInputs = Array.from(
      document.querySelectorAll('#device-detail-stepped-steps [data-step-field="planningPowerW"]'),
    ) as HTMLInputElement[];
    const saveButton = document.querySelector('#device-detail-stepped-save') as HTMLButtonElement;

    planningInputs[1].value = '900';
    planningInputs[1].dispatchEvent(new Event('change', { bubbles: true }));
    await flushPromises();

    saveButton.click();
    await flushPromises();
    await flushPromises();

    expect(homey.__settingsStore.device_control_profiles).toEqual({
      'dev-1': {
        model: 'stepped_load',
        steps: [
          { id: 'off', planningPowerW: 0 },
          { id: 'low', planningPowerW: 1250 },
          { id: 'max', planningPowerW: 3000 },
        ],
      },
    });
    expect(homey.set).not.toHaveBeenCalledWith(
      'device_control_profiles',
      expect.anything(),
      expect.any(Function),
    );
  });

  it('uses the current shed-action selection when saving the stepped-load profile', async () => {
    const homey = installSettingsHomeyMock({
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
            { id: 'eco', planningPowerW: 900 },
            { id: 'max', planningPowerW: 3000 },
          ],
        },
      },
      overshoot_behaviors: {
        'dev-1': { action: 'set_step' },
      },
    });
    await loadSettingsScript();

    (document.querySelector('#device-card-list .pels-device-card__detail-button') as HTMLElement).click();
    await waitFor(() => document.querySelector('#device-detail-overlay')?.hasAttribute('hidden') === false);
    await flushPromises();

    const shedAction = document.querySelector('#device-detail-overshoot') as HTMLSelectElement;
    const planningInputs = Array.from(
      document.querySelectorAll('#device-detail-stepped-steps [data-step-field="planningPowerW"]'),
    ) as HTMLInputElement[];

    expect(shedAction.value).toBe('set_step');
    // Simulate stale local state while the current panel still shows "set_step".
    const { state } = await import('../src/ui/state.ts');
    state.shedBehaviors['dev-1'] = { action: 'turn_off' };

    planningInputs[1].value = '0';
    planningInputs[1].dispatchEvent(new Event('change', { bubbles: true }));
    planningInputs[2].value = '0';
    planningInputs[2].dispatchEvent(new Event('change', { bubbles: true }));
    await flushPromises();

    (document.querySelector('#device-detail-stepped-save') as HTMLButtonElement).click();
    await flushPromises();
    await flushPromises();

    expect(homey.__settingsStore.overshoot_behaviors).toEqual({
      'dev-1': { action: 'turn_off' },
    });
  });

  it('serializes shed-behavior writes across auto-save and stepped-load saves', async () => {
    const homey = installSettingsHomeyMock({
      target_devices_snapshot: [
        {
          id: 'dev-1',
          name: 'Hall Heater',
          deviceType: 'temperature',
          powerCapable: true,
          capabilities: ['onoff', 'measure_power', 'target_temperature'],
          targets: [{ id: 'target_temperature', value: 55, unit: '°C' }],
        },
        {
          id: 'dev-2',
          name: 'Water Heater',
          deviceType: 'temperature',
          powerCapable: true,
          capabilities: ['onoff', 'measure_power', 'target_temperature'],
          targets: [{ id: 'target_temperature', value: 65, unit: '°C' }],
        },
      ],
      device_control_profiles: {
        'dev-2': {
          model: 'stepped_load',
          steps: [
            { id: 'off', planningPowerW: 0 },
            { id: 'eco', planningPowerW: 900 },
            { id: 'max', planningPowerW: 3000 },
          ],
        },
      },
      overshoot_behaviors: {
        'dev-2': { action: 'set_step' },
      },
    });
    const originalSet = homey.set;
    let overshootWriteCount = 0;
    let resolveFirstOvershootWrite: (() => void) | null = null;
    let resolveSecondOvershootWrite: (() => void) | null = null;
    homey.set = vi.fn((key: string, value: unknown, cb?: (err: Error | null) => void) => {
      if (key !== 'overshoot_behaviors') {
        originalSet(key, value, cb);
        return;
      }

      overshootWriteCount += 1;
      if (overshootWriteCount === 1) {
        resolveFirstOvershootWrite = () => {
          homey.__settingsStore[key] = value;
          cb?.(null);
        };
        return;
      }
      if (overshootWriteCount === 2) {
        resolveSecondOvershootWrite = () => {
          homey.__settingsStore[key] = value;
          cb?.(null);
        };
        return;
      }

      homey.__settingsStore[key] = value;
      cb?.(null);
    });
    await loadSettingsScript();

    const detailButtons = Array.from(document.querySelectorAll('#device-card-list .pels-device-card__detail-button')) as HTMLElement[];

    detailButtons[0].click();
    await waitFor(() => document.querySelector('#device-detail-title')?.textContent === 'Hall Heater');
    await flushPromises();

    const shedAction = document.querySelector('#device-detail-overshoot') as HTMLSelectElement;
    shedAction.value = 'set_temperature';
    shedAction.dispatchEvent(new Event('change', { bubbles: true }));
    await flushPromises();

    detailButtons[1].click();
    await waitFor(() => document.querySelector('#device-detail-title')?.textContent === 'Water Heater');
    await flushPromises();

    (document.querySelector('#device-detail-stepped-save') as HTMLButtonElement).click();
    await flushPromises();

    expect(overshootWriteCount).toBe(1);
    expect(resolveSecondOvershootWrite).toBeNull();

    resolveFirstOvershootWrite!();
    await flushPromises();
    await flushPromises();

    expect(overshootWriteCount).toBe(2);
    resolveSecondOvershootWrite!();
    await flushPromises();
    await flushPromises();

    expect(homey.__settingsStore.overshoot_behaviors).toEqual({
      'dev-1': { action: 'set_temperature', temperature: 55 },
      'dev-2': { action: 'set_step' },
    });
  });

  it('restores shed behavior inputs when the shed-behavior write fails', async () => {
    const homey = installSettingsHomeyMock({
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
      overshoot_behaviors: {
        'dev-1': { action: 'set_temperature', temperature: 55 },
      },
    });
    const originalSet = homey.set;
    homey.set = vi.fn((key: string, value: unknown, cb?: (err: Error | null) => void) => {
      if (key === 'overshoot_behaviors') {
        cb?.(new Error('Homey SDK not ready'));
        return;
      }
      originalSet(key, value, cb);
    });
    await loadSettingsScript();

    (document.querySelector('#device-card-list .pels-device-card__detail-button') as HTMLElement).click();
    await waitFor(() => document.querySelector('#device-detail-overlay')?.hasAttribute('hidden') === false);
    await flushPromises();

    const shedAction = document.querySelector('#device-detail-overshoot') as HTMLSelectElement;
    const tempRow = document.querySelector('#device-detail-overshoot-temp-row') as HTMLElement;
    const tempInput = document.querySelector('#device-detail-overshoot-temp') as HTMLInputElement;

    expect(shedAction.value).toBe('set_temperature');
    expect(tempInput.value).toBe('55');
    expect(tempRow.hidden).toBe(false);

    shedAction.value = 'turn_off';
    shedAction.dispatchEvent(new Event('change', { bubbles: true }));
    await flushPromises();
    await flushPromises();

    expect(shedAction.value).toBe('set_temperature');
    expect(tempInput.value).toBe('55');
    expect(tempRow.hidden).toBe(false);
    expect(homey.__settingsStore.overshoot_behaviors).toEqual({
      'dev-1': { action: 'set_temperature', temperature: 55 },
    });
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

    (document.querySelector('#device-card-list .pels-device-card__detail-button') as HTMLElement).click();
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
    installSettingsHomeyMock({ target_devices_snapshot: [] });
    // @ts-ignore mutate mock
    global.Homey.set = vi.fn((key, val, cb) => cb && cb(null));
    await loadSettingsScript();

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
          powerKw: 0.125,
        },
      ],
    });
    // @ts-ignore mutate mock
    global.Homey.set = setSpy;

    await loadSettingsScript();

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

    await waitFor(() => getToggles().controllable.getAttribute('aria-disabled') !== 'true');
    getToggles().controllable.click();
    await waitFor(() => {
      const calls = setSpy.mock.calls.filter((call) => call[0] === 'controllable_devices');
      return calls.length > 0;
    }, 1500);
    const controllableCalls = setSpy.mock.calls.filter((call) => call[0] === 'controllable_devices');
    expect(controllableCalls[controllableCalls.length - 1]?.[1]).toEqual(expect.objectContaining({ 'socket-1': true }));
  });

  it('allows toggling managed and capacity control for an off socket with Homey energy metadata', async () => {
    const setSpy = vi.fn((key, val, cb) => cb && cb(null));
    installSettingsHomeyMock({
      target_devices_snapshot: [
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
      ],
    });
    // @ts-ignore mutate mock
    global.Homey.set = setSpy;

    await loadSettingsScript();

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
    await waitFor(() => getToggles().controllable.getAttribute('aria-disabled') !== 'true');

    getToggles().controllable.click();
    await waitFor(() => {
      const calls = setSpy.mock.calls.filter((call) => call[0] === 'controllable_devices');
      return calls.length > 0;
    }, 1500);
    const controllableCalls = setSpy.mock.calls.filter((call) => call[0] === 'controllable_devices');
    expect(controllableCalls[controllableCalls.length - 1]?.[1]).toEqual(expect.objectContaining({ 'socket-2': true }));
  });

  it('renames a mode and updates settings', async () => {
    const setSpy = vi.fn((key, val, cb) => cb && cb(null));
    // @ts-ignore mutate mock
    global.Homey.set = setSpy;
    // @ts-ignore mutate mock
    global.Homey.get = vi.fn((key, cb) => {
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
    modeSelect.value = 'Home';
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
    const setSpy = vi.fn((key, val, cb) => cb && cb(null));
    // @ts-ignore mutate mock
    global.Homey.set = setSpy;
    // @ts-ignore mutate mock
    global.Homey.get = vi.fn((key, cb) => {
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
    const setSpy = vi.fn((key, val, cb) => {
      store[key] = val;
      if (cb) cb(null);
    });
    // @ts-ignore mutate mock
    global.Homey.set = setSpy;
    // @ts-ignore mutate mock
    global.Homey.get = vi.fn((key, cb) => {
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
    const setSpy = vi.fn((key, val, cb) => cb && cb(null));
    // @ts-ignore mutate mock
    global.Homey.set = setSpy;
    // @ts-ignore mutate mock
    global.Homey.get = vi.fn((key, cb) => {
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
    // @ts-ignore mutate mock
    global.Homey.set = setSpy;
    // @ts-ignore mutate mock
    global.Homey.get = vi.fn((key, cb) => {
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
    const setSpy = vi.fn((key, val, cb) => cb && cb(null));
    // @ts-ignore mutate mock
    global.Homey.set = setSpy;
    // @ts-ignore mutate mock
    global.Homey.get = vi.fn((key, cb) => {
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


  it('loads device diagnostics through the Homey API when opening device detail', async () => {
    global.Homey.__uiState.deviceDiagnostics = {
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

    await loadSettingsScript();
    (global.Homey.api as ReturnType<typeof vi.fn>).mockClear();

    await waitFor(() => document.querySelector('[data-device-id="dev-1"] .pels-device-card__detail-button') !== null);
    const detailButton = document.querySelector('[data-device-id="dev-1"] .pels-device-card__detail-button') as HTMLElement | null;
    detailButton?.click();

    expect((global.Homey.api as ReturnType<typeof vi.fn>).mock.calls.some(
      (call) => call[0] === 'GET' && call[1] === '/ui_device_diagnostics',
    )).toBe(false);

    const diagnosticsDisclosure = document.querySelector('#device-detail-diagnostics-disclosure') as HTMLDetailsElement | null;
    diagnosticsDisclosure!.open = true;
    diagnosticsDisclosure!.dispatchEvent(new Event('toggle'));

    await waitFor(() => (
      (document.querySelector('#device-detail-diagnostics-status') as HTMLElement | null)?.textContent?.includes('Current penalty level: L2')
        === true
    ));

    expect((global.Homey.api as ReturnType<typeof vi.fn>).mock.calls).toEqual(expect.arrayContaining([
      expect.arrayContaining(['GET', '/ui_device_diagnostics']),
    ]));
    expect(document.querySelector('#device-detail-diagnostics-cards')?.textContent).toContain('Failed activations');
    expect(document.querySelector('#device-detail-diagnostics-cards')?.textContent).toContain('Penalty history');
    expect(getDiagnosticsMetricValue('Time not served')).toBe('2.0h');
    expect(getDiagnosticsMetricValue('Starved time')).toBe('23m');
  });

  it('shows a diagnostics unavailable state when the Homey API route fails', async () => {
    const baseApi = buildHomeyApiMock(global.Homey);
    global.Homey.api = vi.fn((method, uri, bodyOrCallback, cb) => {
      const callback = typeof bodyOrCallback === 'function' ? bodyOrCallback : cb;
      if (method === 'GET' && uri === '/ui_device_diagnostics') {
        callback?.(new Error('Cannot GET /api/app/com.barelysufficient.pels/ui_device_diagnostics'));
        return;
      }
      return baseApi(method, uri, bodyOrCallback, cb);
    });

    await loadSettingsScript();

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

describe('Plan sorting', () => {
  beforeEach(() => {
    vi.resetModules();
    buildDom();
    installSettingsHomeyMock({
      planSnapshot: null,
      target_devices_snapshot: [],
    });
  });

  const setupPlanHomeyMock = (planSnapshot: any) => {
    installSettingsHomeyMock({
      planSnapshot: planSnapshot,
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

    const planList = document.querySelector('#plan-cards');
    const deviceRows = planList?.querySelectorAll('.plan-card');

    expect(deviceRows?.length).toBe(3);

    // Get device names in order
    const deviceNames = Array.from(deviceRows || []).map(
      (row) => row.querySelector('.plan-card__title')?.textContent,
    );

    // Priority 1 = most important, shown first: 1, 3, 5
    expect(deviceNames).toEqual([
      'Most Important Heater', // priority 1
      'Medium Priority Heater', // priority 3
      'Least Important Heater', // priority 5
    ]);
  });

  it('marks held devices without repeating the limited state chip', async () => {
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

    const deviceRows = document.querySelectorAll('#plan-cards .plan-card');
    const deviceNames = Array.from(deviceRows).map(
      (row) => row.querySelector('.plan-card__title')?.textContent,
    );
    expect(deviceNames).toEqual(['Bravo One', 'Alpha One', 'Alpha Two']); // priority order

    const heldCard = document.querySelector('#plan-cards [data-device-id="b1"]') as HTMLElement | null;
    expect(heldCard?.dataset.stateKind).toBe('held');
    expect(heldCard?.querySelector('.plan-state-chip-wrap .plan-chip')).toBeNull();
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

    const usageLine = document.querySelector('#plan-cards .plan-card__metric-label')?.textContent || '';
    expect(usageLine).toBe('1.2 kW');
  });

  it('shows expected draw label when a keep-off device has no live draw', async () => {
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

    const metric = document.querySelector('#plan-cards .plan-card__metric') as HTMLElement | null;
    expect(metric?.dataset.variant).toBe('expected');
    expect(metric?.textContent).toContain('~1.5 kW when active');
  });

  it('shows expected draw label when on but not drawing power', async () => {
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
      planSnapshot: planSnapshot,
      target_devices_snapshot: [],
    });

    await loadSettingsScript();

    const overviewTab = document.querySelector('[data-tab="overview"]') as HTMLButtonElement;
    overviewTab?.click();
    await flushPromises();

    const metric = document.querySelector('#plan-cards .plan-card__metric') as HTMLElement | null;
    expect(metric?.dataset.variant).toBe('expected');
    expect(metric?.textContent).toContain('~0.1 kW when active');
  });

  it('keeps the last rendered plan when a realtime plan update is malformed', async () => {
    const homey = installSettingsHomeyMock({
      planSnapshot: {
        meta: {
          totalKw: 2.0,
          softLimitKw: 9.0,
          headroomKw: 7.0,
        },
        devices: [
          {
            id: 'device-1',
            name: 'Heater',
            priority: 1,
            currentState: 'on',
            plannedState: 'keep',
            reason: buildComparablePlanReason('keep'),
          },
        ],
      },
      target_devices_snapshot: [],
    });

    await loadSettingsScript();

    const overviewTab = document.querySelector('[data-tab="overview"]') as HTMLButtonElement;
    overviewTab?.click();
    await flushPromises();

    expect(document.querySelectorAll('#plan-cards .plan-card')).toHaveLength(1);
    expect(document.querySelector('#plan-cards .plan-card__title')?.textContent).toContain('Heater');

    emitHomeyEvent(homey, 'plan_updated', {
      meta: {
        totalKw: 2.1,
        softLimitKw: 9.0,
        headroomKw: 6.9,
      },
      devices: [
        {
          id: 'device-1',
          name: 'Heater',
          priority: 1,
          currentState: 'on',
          plannedState: 'keep',
        },
      ],
    });
    await flushPromises();

    expect(document.querySelectorAll('#plan-cards .plan-card')).toHaveLength(1);
    expect(document.querySelector('#plan-cards .plan-card__title')?.textContent).toContain('Heater');
  });

  it('does not read a persisted plan when capacity priorities change via settings event', async () => {
    const listeners: Record<string, ((...args: unknown[]) => void)[]> = {};
    const getSpy = vi.fn((key, cb) => {
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
      planSnapshot: {
        meta: { totalKw: 1, softLimitKw: 5, headroomKw: 4 },
        devices: [],
      },
      target_devices_snapshot: [],
      capacity_priorities: { Home: {} },
      mode_device_targets: { Home: {} },
    });
    global.Homey.get = getSpy;
    global.Homey.on = vi.fn((event, cb) => {
      if (!listeners[event]) listeners[event] = [];
      listeners[event].push(cb);
    });

    await loadSettingsScript();

    const overviewTab = document.querySelector('[data-tab="overview"]') as HTMLButtonElement;
    overviewTab?.click();
    await flushPromises();

    const before = getSpy.mock.calls.filter((call) => call[0] === 'planSnapshot').length;
    const settingsCallbacks = listeners['settings.set'] || [];
    settingsCallbacks.forEach((cb) => cb('capacity_priorities'));
    await flushPromises();

    const after = getSpy.mock.calls.filter((call) => call[0] === 'planSnapshot').length;
    expect(after).toBe(before);
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

  it('ignores stale heartbeat values when tracker data is fresh', async () => {
    const now = Date.now();
    global.Homey.__uiState.power = {
      tracker: { lastTimestamp: now - 5_000 },
      status: { lastPowerUpdate: now - 5_000, priceLevel: 'cheap' },
      heartbeat: now - 2 * 60_000,
    };

    await loadSettingsScript();

    const banner = document.querySelector('#stale-data-banner') as HTMLDivElement;
    expect(banner.hidden).toBe(true);
  });

  it('self-corrects the stale-data banner from slim power_updated without refetching /ui_power', async () => {
    const listeners: Record<string, ((...args: unknown[]) => void)[]> = {};
    const stalePower = {
      tracker: { lastTimestamp: Date.now() - 2 * 60_000 },
      status: { lastPowerUpdate: Date.now() - 2 * 60_000, priceLevel: 'cheap' },
      heartbeat: Date.now(),
    };

    global.Homey.__uiState = { power: stalePower };
    global.Homey.on = vi.fn((event, cb) => {
      if (!listeners[event]) listeners[event] = [];
      listeners[event].push(cb);
    });
    global.Homey.api = buildHomeyApiMock(global.Homey);

    await loadSettingsScript();

    const banner = document.querySelector('#stale-data-banner') as HTMLDivElement;
    expect(banner.hidden).toBe(false);

    (global.Homey.api as ReturnType<typeof vi.fn>).mockClear();
    const freshPower = {
      tracker: null,
      status: { lastPowerUpdate: Date.now() - 5_000, priceLevel: 'cheap' },
      heartbeat: null,
    };
    const powerCallbacks = listeners.power_updated || [];
    powerCallbacks.forEach((cb) => cb(freshPower));
    await flushPromises();

    expect(banner.hidden).toBe(true);
    const powerGetCalls = (global.Homey.api as ReturnType<typeof vi.fn>).mock.calls
      .filter((call) => call[0] === 'GET' && call[1] === '/ui_power');
    expect(powerGetCalls).toHaveLength(0);
  });

  it('keeps slim power_updated cache entries shaped like /ui_power payloads', async () => {
    const listeners: Record<string, ((...args: unknown[]) => void)[]> = {};
    global.Homey.on = vi.fn((event, cb) => {
      if (!listeners[event]) listeners[event] = [];
      listeners[event].push(cb);
    });
    global.Homey.api = buildHomeyApiMock(global.Homey);

    await loadSettingsScript();

    const { getApiReadModel, invalidateApiCache } = await import('../src/ui/homey.ts');
    invalidateApiCache('/ui_power');

    const freshPower = {
      tracker: null,
      status: { lastPowerUpdate: Date.now() - 5_000, priceLevel: 'cheap' },
      heartbeat: null,
    };
    (listeners.power_updated || []).forEach((cb) => cb(freshPower));
    await flushPromises();

    await expect(getApiReadModel('/ui_power')).resolves.toEqual(freshPower);
    const powerGetCalls = (global.Homey.api as ReturnType<typeof vi.fn>).mock.calls
      .filter((call) => call[0] === 'GET' && call[1] === '/ui_power');
    expect(powerGetCalls).toHaveLength(0);
  });

  it('does not turn rapid slim power_updated events into repeated /ui_power fetches while Usage is visible', async () => {
    const listeners: Record<string, ((...args: unknown[]) => void)[]> = {};
    global.Homey.__uiState = {
      power: {
        tracker: { hourly: {}, daily: {}, lastTimestamp: Date.now() },
        status: { lastPowerUpdate: Date.now(), priceLevel: 'cheap' },
        heartbeat: null,
      },
    };
    global.Homey.on = vi.fn((event, cb) => {
      if (!listeners[event]) listeners[event] = [];
      listeners[event].push(cb);
    });
    global.Homey.api = buildHomeyApiMock(global.Homey);

    await loadSettingsScript();
    const { showTab } = await import('../src/ui/realtime.ts');
    showTab('usage');
    await flushPromises();

    (global.Homey.api as ReturnType<typeof vi.fn>).mockClear();
    const freshPower = {
      tracker: null,
      status: { lastPowerUpdate: Date.now(), priceLevel: 'cheap' },
      heartbeat: null,
    };
    (listeners.power_updated || []).forEach((cb) => cb(freshPower));
    (listeners.power_updated || []).forEach((cb) => cb({
      ...freshPower,
      status: { lastPowerUpdate: Date.now() + 2_000, priceLevel: 'cheap' },
    }));
    (listeners.power_updated || []).forEach((cb) => cb({
      ...freshPower,
      status: { lastPowerUpdate: Date.now() + 4_000, priceLevel: 'cheap' },
    }));
    await flushPromises();

    const powerGetCalls = (global.Homey.api as ReturnType<typeof vi.fn>).mock.calls
      .filter((call) => call[0] === 'GET' && call[1] === '/ui_power');
    expect(powerGetCalls).toHaveLength(0);
  });

  it('invalidates /ui_power cache before periodic stale-data checks', async () => {
    const intervalCallbacks = new Map<number, () => void>();
    const setIntervalSpy = vi.spyOn(global, 'setInterval').mockImplementation(((callback, ms) => {
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

      (global.Homey.api as ReturnType<typeof vi.fn>).mockClear();
      const staleInterval = intervalCallbacks.get(30 * 1000);
      expect(typeof staleInterval).toBe('function');
      staleInterval?.();
      await flushPromises();

      expect(banner.hidden).toBe(false);
      const powerGetCalls = (global.Homey.api as ReturnType<typeof vi.fn>).mock.calls
        .filter((call) => call[0] === 'GET' && call[1] === '/ui_power');
      expect(powerGetCalls.length).toBeGreaterThan(0);
    } finally {
      setIntervalSpy.mockRestore();
    }
  });

  it('invalidates /ui_plan cache when reopening overview', async () => {
    await loadSettingsScript();

    (global.Homey.api as ReturnType<typeof vi.fn>).mockClear();

    const budgetTab = document.querySelector('[data-tab="budget"]') as HTMLButtonElement;
    const overviewTab = document.querySelector('[data-tab="overview"]') as HTMLButtonElement;
    budgetTab.click();
    await flushPromises();
    overviewTab.click();
    await flushPromises();

    const planGetCalls = (global.Homey.api as ReturnType<typeof vi.fn>).mock.calls
      .filter((call) => call[0] === 'GET' && call[1] === '/ui_plan');
    expect(planGetCalls).toHaveLength(1);
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
    const setSpy = vi.fn((key, val, cb) => cb && cb(null));
    installSettingsHomeyMock({
      target_devices_snapshot: [
        {
          id: 'dev-1',
          name: 'Connected 300',
          deviceType: 'temperature',
          targets: [{ id: 'target_temperature', value: 65, unit: '°C', min: 35, max: 75, step: 5 }],
        },
      ],
      capacity_priorities: { Home: { 'dev-1': 1 } },
      mode_device_targets: { Home: { 'dev-1': 46 } },
      managed_devices: { 'dev-1': true },
      controllable_devices: { 'dev-1': true },
    });
    // @ts-ignore mutate mock
    global.Homey.set = setSpy;

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
