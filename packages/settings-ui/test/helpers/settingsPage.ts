// The settings page harness shared by the settings*.test.ts specs: a jsdom page,
// the boot/load entry points, and a Homey mock seeded from settings fixtures.
import { withDescriptorIdentity } from './deviceSnapshotFixture.ts';
import type { TargetDeviceSnapshot } from '../../../contracts/src/types.ts';
import { installedHomeyMock, installHomeyMock } from './homeyApiMock';

export const flushPromises = () => new Promise<void>((resolve) => {
  const queueMicrotaskFn = (globalThis as { queueMicrotask?: (cb: () => void) => void }).queueMicrotask;
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

export const waitFor = async (predicate: () => boolean, timeoutMs = 1000) => {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`waitFor timed out after ${timeoutMs}ms`);
    }
    await flushPromises();
  }
};

export const getDiagnosticsMetricValue = (label: string): string | null => {
  const cards = document.querySelector('#device-detail-diagnostics-cards');
  const labels = Array.from(cards?.querySelectorAll('dt') ?? []);
  const labelNode = labels.find((node) => node.textContent === label);
  return labelNode?.nextElementSibling?.textContent ?? null;
};

/**
 * Basic render test for the settings UI with Homey mocked.
 */
export const buildDom = () => {
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
      <div id="current-modes-root"></div>
      <button data-settings-target="limits"></button>
      <button data-settings-target="budget-adjust"></button>
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
          <md-select-option value="homey_energy"><div slot="headline">Power meter</div></md-select-option>
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
      <md-filled-tonal-button id="add-mode-button"></md-filled-tonal-button>
      <md-text-button id="rename-mode-button"></md-text-button>
      <md-text-button id="delete-mode-button"></md-text-button>
      <div id="mode-name-editor" hidden>
        <md-filled-text-field id="mode-new"></md-filled-text-field>
        <md-text-button id="mode-name-cancel"></md-text-button>
        <md-filled-tonal-button id="mode-name-confirm"></md-filled-tonal-button>
      </div>
      <md-dialog id="mode-delete-dialog"><p id="mode-delete-message"></p></md-dialog>
      <form id="priority-form"></form>
      <div id="priority-list"></div>
      <p id="priority-empty" hidden></p>
    </section>
    <section class="panel hidden" id="budget-panel" data-panel="budget">
      <div id="budget-redesign-surface"></div>
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

export const loadSettingsScript = async () => {
  const { boot } = await import('../../src/ui/boot.ts');
  await boot();
  // Devices are lazy-loaded on first device-related tab visit. In the redesign, the
  // devices section is reached via Settings > Devices.
  (document.querySelector('[data-settings-target="devices"]') as HTMLButtonElement | null)?.click();
  await waitFor(() => {
    const hasRows = document.querySelectorAll('#device-card-list .pels-device-card__row').length > 0;
    const emptyVisible = document.querySelector('#empty-state')?.hasAttribute('hidden') === false;
    return hasRows || emptyVisible;
  });
  await waitFor(() => Boolean(
    (document.querySelector('#active-mode-select') as HTMLSelectElement | null)?.value,
  ));
};

// Device/editor scenarios exercise their real feature initializers without loading
// unrelated Budget/Usage/price views or starting the whole shell's polling loops.
// Boot, navigation and realtime scenarios below still use loadSettingsScript.
export const loadDeviceAndModeSettings = async () => {
  await import('../../src/ui/materialWeb.ts');
  const { setHomeyClient } = await import('../../src/ui/homey.ts');
  setHomeyClient(installedHomeyMock());
  const { state } = await import('../../src/ui/state.ts');
  const { loadModeAndPriorities, initModeHandlers, renderPriorities } = await import('../../src/ui/modes.ts');
  const { refreshHomeScope } = await import('../../src/ui/homeScope.ts');
  const { refreshCurrentModes } = await import('../../src/ui/currentModes.ts');
  const { getTargetDevices, renderDevices } = await import('../../src/ui/devices.ts');
  const { loadDeviceControlProfiles } = await import('../../src/ui/deviceControlProfiles.ts');
  const { initDeviceDetailHandlers, loadShedBehaviors } = await import('../../src/ui/deviceDetail/index.ts');
  await refreshHomeScope();
  await loadModeAndPriorities();
  await Promise.all([loadDeviceControlProfiles(), loadShedBehaviors(), refreshCurrentModes()]);
  initModeHandlers();
  initDeviceDetailHandlers();
  state.latestDevices = await getTargetDevices();
  state.devicesLoaded = true;
  state.initialLoadComplete = true;
  renderDevices(state.latestDevices);
  renderPriorities(state.latestDevices);
};

// Module resets do not unload the jsdom page. Remove registrations on the
// surviving document/window and cancel real timers before replacing its body.
// Registers that cleanup after each test and returns a handle to run it early.
export const releasePageResourcesAfterEachTest = (): () => void => {
  let releasePageResources = () => {};
  beforeEach(() => {
    const listeners: Array<() => void> = [];
    const trackListeners = (target: EventTarget) => {
      const addEventListener = target.addEventListener.bind(target);
      return vi.spyOn(target, 'addEventListener').mockImplementation((type, listener, options) => {
        addEventListener(type, listener, options);
        listeners.push(() => target.removeEventListener(type, listener, options));
      });
    };
    // Vitest exposes bound window methods, so a prototype spy misses them.
    const documentListenerSpy = trackListeners(document);
    const windowListenerSpy = trackListeners(window);
    const requestAnimationFrame = globalThis.requestAnimationFrame;
    const frames: number[] = [];
    const frameSpy = vi.spyOn(globalThis, 'requestAnimationFrame').mockImplementation((callback) => {
      const frame = requestAnimationFrame(callback);
      frames.push(frame);
      return frame;
    });
    const setTimeout = globalThis.setTimeout;
    const timeouts: Array<ReturnType<typeof setTimeout>> = [];
    const timeoutSpy = vi.spyOn(globalThis, 'setTimeout').mockImplementation((...args) => {
      const timer = setTimeout(...args);
      timeouts.push(timer);
      return timer;
    });
    const setInterval = globalThis.setInterval;
    const intervals: Array<ReturnType<typeof setInterval>> = [];
    const intervalSpy = vi.spyOn(globalThis, 'setInterval').mockImplementation((...args) => {
      const timer = setInterval(...args);
      intervals.push(timer);
      return timer;
    });
    releasePageResources = () => {
      document.body.replaceChildren();
      listeners.forEach((remove) => remove());
      // jsdom's RAF queue owns a Node interval. Cancel its frame handles first
      // so clearing timers cannot strand a nonempty queue without its clock.
      frames.forEach((frame) => cancelAnimationFrame(frame));
      timeouts.forEach((timer) => clearTimeout(timer));
      intervals.forEach((timer) => clearInterval(timer));
      documentListenerSpy.mockRestore();
      windowListenerSpy.mockRestore();
      frameSpy.mockRestore();
      timeoutSpy.mockRestore();
      intervalSpy.mockRestore();
    };
  });
  afterEach(() => releasePageResources());
  return () => releasePageResources();
};

export const DEFAULT_SETTINGS_DEVICES = [
  withDescriptorIdentity<TargetDeviceSnapshot>({
    id: 'dev-1',
    name: 'Heater',
    available: true,
    targets: [{ id: 'target_temperature', value: 21, unit: '°C' }],
  } as unknown as TargetDeviceSnapshot),
];

const withResolvedPlanDeviceBooleans = (value: unknown): unknown => {
  if (!value || typeof value !== 'object') return value;
  const devices = (value as { devices?: unknown }).devices;
  if (!Array.isArray(devices)) return value;
  return {
    ...value,
    devices: devices.map((device) => (
      device && typeof device === 'object'
        ? { controllable: true, available: true, isEvCharger: false, ...device }
        : device
    )),
  };
};

export const buildSettingsHomeyState = (settings: Record<string, unknown> = {}) => {
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

export const installSettingsHomeyMock = (settings: Record<string, unknown> = {}) => {
  const requestedDevices = Object.prototype.hasOwnProperty.call(settings, 'target_devices_snapshot')
    ? settings.target_devices_snapshot
    : DEFAULT_SETTINGS_DEVICES;
  // The Overview renders the DEVICE list joined to the plan, so a fixture that
  // supplies a plan and an EMPTY device list draws no cards. Production's
  // device list is a superset of the plan's devices, so fall back to mirroring
  // the plan's ids rather than leaving the surface empty. A fixture that names
  // its own devices still wins.
  const planDevices = (settings.planSnapshot as { devices?: Array<Record<string, unknown>> } | undefined)?.devices;
  const explicitDevices = Array.isArray(requestedDevices) && requestedDevices.length === 0 && Array.isArray(planDevices)
    ? planDevices.map((device) => ({ id: device.id, name: device.name, priority: device.priority, targets: [] }))
    : requestedDevices;
  return installHomeyMock({
    settings: buildSettingsHomeyState(settings),
    uiState: {
      devices: Array.isArray(explicitDevices)
        // Identity facts the producer always sets and the list parser requires.
        ? explicitDevices.map((device) => withDescriptorIdentity<TargetDeviceSnapshot>(
          { available: true, ...device } as unknown as TargetDeviceSnapshot,
        ))
        : [],
      plan: withResolvedPlanDeviceBooleans(settings.planSnapshot),
    },
  });
};
