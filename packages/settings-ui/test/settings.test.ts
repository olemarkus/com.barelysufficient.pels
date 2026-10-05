import type { TargetDeviceSnapshot } from '../../contracts/src/types.ts';
import { installHomeyMock } from './helpers/homeyApiMock';
import {
  DEFAULT_SETTINGS_DEVICES,
  buildDom,
  buildSettingsHomeyState,
  flushPromises,
  installSettingsHomeyMock,
  loadDeviceAndModeSettings,
  loadSettingsScript,
  releasePageResourcesAfterEachTest,
  waitFor,
} from './helpers/settingsPage.ts';

vi.mock('../src/ui/toast.ts', () => ({
  showToast: vi.fn().mockResolvedValue(undefined),
  showToastError: vi.fn().mockResolvedValue(undefined),
}));

const releasePageResources = releasePageResourcesAfterEachTest();

describe('settings script', () => {
  beforeEach(() => {
    vi.resetModules();
    buildDom();
    window.localStorage.clear();
    installSettingsHomeyMock();
  });

  it('releases old page callbacks while keeping animation frames usable for the next page', async () => {
    const oldPageEvent = vi.fn();
    const oldPageFrame = vi.fn();
    window.addEventListener('pels:test-page', oldPageEvent);
    requestAnimationFrame(oldPageFrame);

    releasePageResources();

    window.dispatchEvent(new Event('pels:test-page'));
    let nextPagePainted = false;
    requestAnimationFrame(() => { nextPagePainted = true; });
    await waitFor(() => nextPagePainted);
    expect(oldPageEvent).not.toHaveBeenCalled();
    expect(oldPageFrame).not.toHaveBeenCalled();
  });

  it('renders devices with target temperature capabilities', async () => {
    await loadSettingsScript();

    const rows = document.querySelectorAll('#device-card-list .pels-device-card__row');
    expect(rows.length).toBe(1);
    expect(rows[0].querySelector('.device-row__name')?.textContent).toContain('Heater');
    expect(document.querySelector('#empty-state')?.hasAttribute('hidden')).toBe(true);
  });

  it('opens Budget → Adjust with a Settings return target via the budget-adjust deep link', async () => {
    await loadSettingsScript();
    const { showTab } = await import('../src/ui/realtime.ts');
    showTab('settings');

    (document.querySelector('[data-settings-target="budget-adjust"]') as HTMLButtonElement).click();
    await flushPromises();

    // The virtual 'budget-adjust' target must open the budget panel — and must
    // NOT leak into showTab (it matches no data-panel and would hide every
    // panel, blanking the app).
    const budgetPanel = document.querySelector('#budget-panel');
    const settingsPanel = document.querySelector('#settings-panel');
    expect(budgetPanel?.classList.contains('hidden')).toBe(false);
    expect(settingsPanel?.classList.contains('hidden')).toBe(true);

    // The Adjust view is open, and — because the session came from Settings —
    // its exit is the shared `.pels-appbar` back arrow, not the boxed hero +
    // trailing "Done" toggle. Matches the eight sibling settings sub-pages.
    expect(document.querySelector('#budget-redesign-adjust-view')).not.toBeNull();
    expect(document.querySelector('#budget-redesign-mode-toggle')).toBeNull();
    const back = document.querySelector('.pels-appbar__back');
    expect(back).not.toBeNull();

    (back as HTMLElement).click();
    await flushPromises();
    expect(settingsPanel?.classList.contains('hidden')).toBe(false);
    expect(budgetPanel?.classList.contains('hidden')).toBe(true);

    // The settings-initiated session fully ended: a direct Budget-tab visit
    // must not inherit the 'settings' referrer (the fixture's budget is
    // disabled, so the view pins to Adjust and the Done toggle goes back to
    // being disabled once the referrer is reset).
    (document.querySelector('.tab[data-tab="budget"]') as HTMLButtonElement).click();
    await flushPromises();
    expect(budgetPanel?.classList.contains('hidden')).toBe(false);
    const pinnedToggle = document.querySelector('#budget-redesign-mode-toggle');
    expect(Boolean((pinnedToggle as HTMLElement & { disabled?: boolean | string }).disabled)).toBe(true);
  });

  it('a direct Budget-tab tap dismisses a settings-referred Adjust editor to the normal Budget overview', async () => {
    await loadSettingsScript();
    const { showTab } = await import('../src/ui/realtime.ts');
    showTab('settings');

    // Open the Daily-budget editor from Settings: the budget panel shows the
    // adjust editor with the shared app-bar back arrow, and the Settings tab
    // indicator stays lit (the editor reads as a Settings sub-page).
    (document.querySelector('[data-settings-target="budget-adjust"]') as HTMLButtonElement).click();
    await flushPromises();
    expect(document.querySelector('#budget-panel .pels-appbar__back')).not.toBeNull();
    expect(document.querySelector('.tab[data-tab="settings"]')?.getAttribute('aria-selected')).toBe('true');

    // Tapping the now-inactive Budget tab must land on the normal Budget
    // overview: the settings-referred app-bar exit is gone and the Budget tab
    // lights — not a Budget-lit tab still showing the adjust sub-view + a
    // "back to Settings" affordance (the item-A interaction regression).
    (document.querySelector('.tab[data-tab="budget"]') as HTMLButtonElement).click();
    await flushPromises();
    expect(document.querySelector('#budget-panel')?.classList.contains('hidden')).toBe(false);
    expect(document.querySelector('#budget-panel .pels-appbar__back')).toBeNull();
    expect(document.querySelector('.tab[data-tab="budget"]')?.getAttribute('aria-selected')).toBe('true');
    expect(document.querySelector('.tab[data-tab="settings"]')?.getAttribute('aria-selected')).toBe('false');
  });

  it('toasts on an unconfirmed tab-bar exit with unsaved budget edits, but stays silent after a confirmed Done', async () => {
    await loadSettingsScript();
    const { showTab } = await import('../src/ui/realtime.ts');
    const { showToast } = await import('../src/ui/toast.ts');
    showTab('settings');

    const openAdjustAndDirtyDraft = async () => {
      (document.querySelector('[data-settings-target="budget-adjust"]') as HTMLButtonElement).click();
      await flushPromises();
      const enableSwitch = document.querySelector('#budget-redesign-enabled') as HTMLElement & { selected?: boolean };
      enableSwitch.selected = true;
      enableSwitch.dispatchEvent(new Event('change', { bubbles: true }));
      await flushPromises();
    };

    // Unconfirmed exit via the tab bar discards with a notice.
    await openAdjustAndDirtyDraft();
    vi.mocked(showToast).mockClear();
    showTab('devices');
    await flushPromises();
    expect(showToast).toHaveBeenCalledWith('Discarded unsaved budget changes.');

    // The confirmed back-arrow path stays silent — the user already confirmed
    // the discard on the two-step control. Settings-referred exit is the
    // app-bar back arrow; a dirty draft arms the confirm (`.confirming` glyph)
    // on the first tap and only returns on the second — the icon-only
    // equivalent of "Tap again to discard".
    showTab('settings');
    await openAdjustAndDirtyDraft();
    vi.mocked(showToast).mockClear();
    (document.querySelector('.pels-appbar__back') as HTMLElement).click();
    await flushPromises();
    expect((document.querySelector('.pels-appbar__back') as HTMLElement).classList.contains('confirming')).toBe(true);
    (document.querySelector('.pels-appbar__back') as HTMLElement).click();
    await flushPromises();
    expect(document.querySelector('#settings-panel')?.classList.contains('hidden')).toBe(false);
    expect(showToast).not.toHaveBeenCalledWith('Discarded unsaved budget changes.');
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
          power: { tracker: {}, status: { state: 'unavailable', reason: 'no_status_recorded' }, readings: { state: 'never' } },
          prices: {
            combinedPrices: null,
            priceArea: null,
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
    await loadDeviceAndModeSettings();

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
    await loadDeviceAndModeSettings();

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
    expect(stepOption.textContent).toBe('Set to Low');
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
          steps: [
            { id: 'off', planningPowerW: 0 },
            { id: 'low', planningPowerW: 1250 },
            { id: 'max', planningPowerW: 3000 },
          ],
        },
      },
      overshoot_behaviors: {
        'dev-1': { action: 'set_temperature', temperature: 50 },
      },
    });
    await loadDeviceAndModeSettings();

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
    expect(tempInput.value).toBe('50');
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
    await loadDeviceAndModeSettings();

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
    await loadDeviceAndModeSettings();

    (document.querySelector('#device-card-list .pels-device-card__detail-button') as HTMLElement).click();
    await waitFor(() => document.querySelector('#device-detail-overlay')?.hasAttribute('hidden') === false);
    await flushPromises();

    const shedAction = document.querySelector('#device-detail-overshoot') as HTMLSelectElement;
    const stepOption = shedAction.querySelector('md-select-option[value="set_step"]') as HTMLOptionElement;
    const planningInputs = Array.from(
      document.querySelectorAll('#device-detail-stepped-steps [data-step-field="planningPowerW"]'),
    ) as HTMLInputElement[];

    expect(stepOption.textContent).toBe('Set to Eco');

    planningInputs[1].value = '0';
    planningInputs[1].dispatchEvent(new Event('change', { bubbles: true }));
    await flushPromises();

    expect(stepOption.textContent).toBe('Set to Max');
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
    await loadDeviceAndModeSettings();

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
    await loadDeviceAndModeSettings();

    (document.querySelector('#device-card-list .pels-device-card__detail-button') as HTMLElement).click();
    await waitFor(() => document.querySelector('#device-detail-overlay')?.hasAttribute('hidden') === false);
    await flushPromises();

    const shedAction = document.querySelector('#device-detail-overshoot') as HTMLSelectElement;
    const planningInputs = Array.from(
      document.querySelectorAll('#device-detail-stepped-steps [data-step-field="planningPowerW"]'),
    ) as HTMLInputElement[];

    expect(shedAction.value).toBe('set_step');
    // Simulate stale local state while the current panel still shows "set_step".
    // Reading the stale copy instead of the live selection would skip the
    // shed-behavior write entirely, which is what the assertions below catch.
    const { state } = await import('../src/ui/state.ts');
    state.shedBehaviors['dev-1'] = { action: 'turn_off' };

    planningInputs[1].value = '1200';
    planningInputs[1].dispatchEvent(new Event('change', { bubbles: true }));
    await flushPromises();

    (document.querySelector('#device-detail-stepped-save') as HTMLButtonElement).click();
    await flushPromises();
    await flushPromises();

    expect(homey.set).toHaveBeenCalledWith(
      'overshoot_behaviors',
      expect.anything(),
      expect.any(Function),
    );
    expect(homey.__settingsStore.overshoot_behaviors).toEqual({
      'dev-1': { action: 'set_step' },
    });
  });

  it('refuses to save a stepped profile with no step the device can run at', async () => {
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
    await loadDeviceAndModeSettings();
    const { showToastError } = await import('../src/ui/toast.ts');
    vi.mocked(showToastError).mockClear();

    (document.querySelector('#device-card-list .pels-device-card__detail-button') as HTMLElement).click();
    await waitFor(() => document.querySelector('#device-detail-overlay')?.hasAttribute('hidden') === false);
    await flushPromises();

    // Zero out every step above off. PELS could pause this device and never
    // resume it, so the save is refused outright rather than downgraded.
    const planningInputs = Array.from(
      document.querySelectorAll('#device-detail-stepped-steps [data-step-field="planningPowerW"]'),
    ) as HTMLInputElement[];
    planningInputs[1].value = '0';
    planningInputs[1].dispatchEvent(new Event('change', { bubbles: true }));
    planningInputs[2].value = '0';
    planningInputs[2].dispatchEvent(new Event('change', { bubbles: true }));
    await flushPromises();

    (document.querySelector('#device-detail-stepped-save') as HTMLButtonElement).click();
    await flushPromises();
    await flushPromises();

    expect(vi.mocked(showToastError)).toHaveBeenCalled();
    // The stored profile and the shed behavior are both left exactly as they were.
    expect(homey.__settingsStore.device_control_profiles).toEqual({
      'dev-1': {
        steps: [
          { id: 'off', planningPowerW: 0 },
          { id: 'eco', planningPowerW: 900 },
          { id: 'max', planningPowerW: 3000 },
        ],
      },
    });
    expect(homey.__settingsStore.overshoot_behaviors).toEqual({
      'dev-1': { action: 'set_step' },
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
    await loadDeviceAndModeSettings();

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
      'dev-1': { action: 'set_temperature', temperature: 50, coolingTemperature: 28 },
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
        'dev-1': { action: 'set_temperature', temperature: 50 },
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
    await loadDeviceAndModeSettings();

    (document.querySelector('#device-card-list .pels-device-card__detail-button') as HTMLElement).click();
    await waitFor(() => document.querySelector('#device-detail-overlay')?.hasAttribute('hidden') === false);
    await flushPromises();

    const shedAction = document.querySelector('#device-detail-overshoot') as HTMLSelectElement;
    const tempRow = document.querySelector('#device-detail-overshoot-temp-row') as HTMLElement;
    const tempInput = document.querySelector('#device-detail-overshoot-temp') as HTMLInputElement;

    expect(shedAction.value).toBe('set_temperature');
    expect(tempInput.value).toBe('50');
    expect(tempRow.hidden).toBe(false);

    shedAction.value = 'turn_off';
    shedAction.dispatchEvent(new Event('change', { bubbles: true }));
    await flushPromises();
    await flushPromises();

    expect(shedAction.value).toBe('set_temperature');
    expect(tempInput.value).toBe('50');
    expect(tempRow.hidden).toBe(false);
    expect(homey.__settingsStore.overshoot_behaviors).toEqual({
      'dev-1': { action: 'set_temperature', temperature: 50 },
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
    await loadDeviceAndModeSettings();

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
});
