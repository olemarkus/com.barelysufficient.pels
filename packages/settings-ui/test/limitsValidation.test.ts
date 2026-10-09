// Unit coverage for the inline margin/hard-cap validation hint in Limits & safety.
// Verifies that the alert text appears as soon as the user enters an invalid
// pair, that it clears once the pair becomes valid, and that the save path
// blocks the API call without silently snapping the field back.

import { resolvePowerLimitSettings } from '../../shared-domain/src/settings/powerLimits';
import type { SettingsUiCapacityPeak } from '../../contracts/src/settingsUiApi.ts';

const LIMITS_FORM_TEMPLATE = [
  '<form id="settings-limits-form">',
  '<md-switch id="settings-capacity-enabled"></md-switch>',
  '<div id="settings-capacity-fields"></div>',
  '<md-switch id="settings-grid-import-enabled"></md-switch>',
  '<div id="settings-grid-import-field" hidden></div>',
  '<md-filled-text-field id="settings-grid-import-limit"></md-filled-text-field>',
  '<small id="settings-grid-import-hint"></small>',
  '<md-filled-text-field id="settings-capacity-limit"></md-filled-text-field>',
  '<md-filled-text-field id="settings-capacity-margin"></md-filled-text-field>',
  '<md-filled-select id="settings-capacity-period"></md-filled-select>',
  '<span id="settings-capacity-reaction"></span>',
  '<div id="settings-capacity-monthly-peak" hidden><span id="settings-capacity-monthly-peak-value">Peak unavailable</span></div>',
  '<small id="settings-capacity-margin-alert" hidden></small>',
  '<md-filled-select id="settings-power-source"></md-filled-select>',
  '<md-switch id="settings-simulation-mode"></md-switch>',
  '<div id="dry-run-banner" hidden></div>',
  '<div id="stale-data-banner" hidden></div>',
  '<span id="stale-data-text"></span>',
  '</form>',
].join('');

const buildLimitsDom = () => {
  // Static template constructed from a literal — no untrusted content.
  document.body.innerHTML = LIMITS_FORM_TEMPLATE;
  (document.querySelector('#settings-capacity-enabled') as HTMLElement & { selected: boolean }).selected = true;
  const limit = document.querySelector('#settings-capacity-limit') as HTMLElement & { value: string };
  const margin = document.querySelector('#settings-capacity-margin') as HTMLElement & { value: string };
  const powerSource = document.querySelector('#settings-power-source') as HTMLElement & { value: string };
  const period = document.querySelector('#settings-capacity-period') as HTMLElement & { value: string };
  limit.value = '';
  margin.value = '';
  powerSource.value = 'flow';
  period.value = '60';
  return {
    limit,
    margin,
    powerSource,
    period,
    alert: document.querySelector('#settings-capacity-margin-alert') as HTMLElement,
  };
};

const loadCapacityModuleWithWriter = async (
  settings: Record<string, unknown>,
  powerReadError: Error | undefined,
  capacityPeak: SettingsUiCapacityPeak,
  writeSetting: (
    key: string,
    value: unknown,
    settingsStore: Record<string, unknown>,
  ) => Promise<void>,
) => {
  vi.resetModules();
  const settingsStore: Record<string, unknown> = {
    capacity_limit_kw: 8,
    capacity_margin_kw: 0.5,
    capacity_dry_run: true,
    power_source: 'flow',
    ...settings,
  };
  const setSetting = vi.fn(async (key: string, value: unknown) => {
    await writeSetting(key, value, settingsStore);
  });
  const getSetting = vi.fn().mockImplementation(async (key: string) => settingsStore[key]);
  vi.doMock('../src/ui/homey.ts', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../src/ui/homey.ts')>();
    return {
      ...actual,
      setSetting,
      getSetting,
    };
  });
  vi.doMock('../src/ui/power.ts', () => ({
    getPowerReadModel: powerReadError
      ? vi.fn().mockRejectedValue(powerReadError)
      : vi.fn().mockImplementation(async () => ({
        tracker: {},
        readings: { state: 'never' },
        status: { state: 'unavailable', reason: 'no_measurement' },
        capacityPeak,
        capacityScalars: {
          state: 'resolved',
          scalars: {
            limitKw: settingsStore.capacity_limit_kw,
            marginKw: settingsStore.capacity_margin_kw,
            periodMinutes: settingsStore.capacity_period_minutes ?? 60,
            dryRun: settingsStore.capacity_dry_run,
            ...resolvePowerLimitSettings(
              settingsStore.capacity_enabled ?? true,
              settingsStore.grid_import_enabled ?? false,
              settingsStore.grid_import_limit_kw,
            ),
          },
        },
        hardCapConfiguration: { state: 'unavailable' },
      })),
  }));
  const showToast = vi.fn().mockResolvedValue(undefined);
  vi.doMock('../src/ui/toast.ts', () => ({
    showToast,
    showToastError: vi.fn().mockResolvedValue(undefined),
  }));
  const capacity = await import('../src/ui/capacity.ts');
  return {
    capacity,
    setSetting,
    getSetting,
    showToast,
    settingsStore,
  };
};

const persistSettingImmediately = async (
  key: string,
  value: unknown,
  settingsStore: Record<string, unknown>,
): Promise<void> => {
  settingsStore[key] = value;
};

const loadCapacityModule = async (
  settings: Record<string, unknown> = {},
  powerReadError?: Error,
  capacityPeak: SettingsUiCapacityPeak = { state: 'recorded', peakKw: 4.75 },
) => loadCapacityModuleWithWriter(
  settings,
  powerReadError,
  capacityPeak,
  persistSettingImmediately,
);

describe('Limits & safety inline validation', () => {

  it('writes the grid threshold before enabling grid control, independently of capacity', async () => {
    const dom = buildLimitsDom();
    const { capacity, setSetting, settingsStore } = await loadCapacityModule();
    await capacity.loadCapacitySettings();
    const grid = document.querySelector('#settings-grid-import-enabled') as HTMLElement & { selected: boolean };
    const cap = document.querySelector('#settings-capacity-enabled') as HTMLElement & { selected: boolean };
    const input = document.querySelector('#settings-grid-import-limit') as HTMLElement & { value: string };
    grid.selected = true;
    cap.selected = false;
    input.value = '3.3';
    capacity.refreshPowerLimitControls();
    expect(document.querySelector('#settings-capacity-fields')?.hasAttribute('hidden')).toBe(true);
    expect(document.querySelector('#settings-grid-import-hint')?.textContent).toContain('3.13 kW');
    await capacity.saveSettingsLimitsSettings();
    const keys = setSetting.mock.calls.map(([key]) => key);
    expect(keys.indexOf('grid_import_limit_kw')).toBeGreaterThanOrEqual(0);
    expect(keys.indexOf('grid_import_limit_kw')).toBeLessThan(keys.indexOf('grid_import_enabled'));
    expect(keys.indexOf('grid_import_enabled')).toBeLessThan(keys.indexOf('capacity_enabled'));
    expect(settingsStore.capacity_enabled).toBe(false);
    expect(dom.limit.value).toBe('8');
  });

  it('moves no switch when a threshold write fails, and reconciles after every started write settles', async () => {
    const dom = buildLimitsDom();
    let releaseMargin!: () => void;
    let markMarginStarted!: () => void;
    const marginStarted = new Promise<void>((resolve) => { markMarginStarted = resolve; });
    const marginWrite = new Promise<void>((resolve) => { releaseMargin = resolve; });
    const { capacity, settingsStore } = await loadCapacityModuleWithWriter(
      {}, undefined, { state: 'recorded', peakKw: 4.75 },
      async (key, value, store) => {
        if (key === 'capacity_limit_kw') throw new Error('capacity write failed');
        if (key === 'capacity_margin_kw') {
          markMarginStarted();
          await marginWrite;
        }
        store[key] = value;
      },
    );
    await capacity.loadCapacitySettings();
    const grid = document.querySelector('#settings-grid-import-enabled') as HTMLElement & { selected: boolean };
    const input = document.querySelector('#settings-grid-import-limit') as HTMLElement & { value: string };
    grid.selected = true;
    input.value = '3.3';
    dom.limit.value = '12';
    dom.margin.value = '0.8';
    let settled = false;
    const save = capacity.saveSettingsLimitsSettings().catch((caught: unknown) => {
      settled = true;
      return caught;
    });
    await marginStarted;
    await new Promise<void>((resolve) => { setTimeout(resolve, 0); });
    expect(settled).toBe(false);
    expect(settingsStore.grid_import_limit_kw).toBe(3.3);
    expect(settingsStore.grid_import_enabled).toBeUndefined();
    releaseMargin();
    expect(await save).toEqual(new Error('capacity write failed'));
    expect(settingsStore.capacity_margin_kw).toBe(0.8);
    expect(settingsStore.grid_import_enabled).toBeUndefined();
    expect(grid.selected).toBe(false);
    expect(input.value).toBe('3.3');
    await capacity.loadCapacitySettings();
    expect(grid.selected).toBe(false);
  });

  it('shows the saved control posture while the running app cannot be read', async () => {
    buildLimitsDom();
    const { capacity, setSetting } = await loadCapacityModule(
      {
        capacity_enabled: false, grid_import_enabled: true, grid_import_limit_kw: 3.3, capacity_period_minutes: 60,
      },
      new Error('power read failed'),
    );
    await capacity.loadCapacitySettings();
    const cap = document.querySelector('#settings-capacity-enabled') as HTMLElement & { selected: boolean };
    const grid = document.querySelector('#settings-grid-import-enabled') as HTMLElement & { selected: boolean };
    const input = document.querySelector('#settings-grid-import-limit') as HTMLElement & { value: string };
    expect(cap.selected).toBe(false);
    expect(grid.selected).toBe(true);
    input.value = '4';
    await capacity.saveSettingsLimitsSettings();
    expect(setSetting.mock.calls).toEqual([['grid_import_limit_kw', 4]]);
  });

  it('takes the running posture for a switch that reads back null', async () => {
    buildLimitsDom();
    const { capacity, setSetting } = await loadCapacityModule({
      capacity_enabled: null, grid_import_enabled: true, grid_import_limit_kw: 3.3, capacity_period_minutes: 60,
    });
    const power = await import('../src/ui/power.ts');
    vi.mocked(power.getPowerReadModel).mockResolvedValue({
      tracker: {}, readings: { state: 'never' },
      status: { state: 'unavailable', reason: 'no_measurement' },
      capacityPeak: { state: 'recorded', peakKw: 4.75 },
      capacityScalars: {
        state: 'resolved',
        scalars: { limitKw: 8, marginKw: 0.5, periodMinutes: 60, dryRun: true,
          capacityEnabled: false, gridImportLimitKw: 3.3 },
      },
      hardCapConfiguration: { state: 'resolved', configured: true },
    });
    await capacity.loadCapacitySettings();
    const cap = document.querySelector('#settings-capacity-enabled') as HTMLElement & { selected: boolean };
    expect(cap.selected).toBe(false);
    (document.querySelector('#settings-grid-import-limit') as HTMLElement & { value: string }).value = '4';
    await capacity.saveSettingsLimitsSettings();
    expect(setSetting.mock.calls).toEqual([['grid_import_limit_kw', 4]]);
  });

  it('turns capacity control on before turning grid control off', async () => {
    buildLimitsDom();
    const { capacity, setSetting } = await loadCapacityModule({
      capacity_enabled: false, grid_import_enabled: true, grid_import_limit_kw: 3.3, capacity_period_minutes: 60,
    });
    await capacity.loadCapacitySettings();
    (document.querySelector('#settings-capacity-enabled') as HTMLElement & { selected: boolean }).selected = true;
    (document.querySelector('#settings-grid-import-enabled') as HTMLElement & { selected: boolean }).selected = false;
    await capacity.saveSettingsLimitsSettings();
    expect(setSetting.mock.calls).toEqual([['capacity_enabled', true], ['grid_import_enabled', false]]);
  });

  it('does not let a load that started mid-save repaint the switches it replaced', async () => {
    buildLimitsDom();
    let releaseEnable!: () => void;
    let markEnableStarted!: () => void;
    const enableStarted = new Promise<void>((resolve) => { markEnableStarted = resolve; });
    const enableWrite = new Promise<void>((resolve) => { releaseEnable = resolve; });
    const { capacity, settingsStore } = await loadCapacityModuleWithWriter(
      { capacity_enabled: false, grid_import_enabled: true, grid_import_limit_kw: 3.3, capacity_period_minutes: 60 },
      undefined,
      { state: 'recorded', peakKw: 4.75 },
      async (key, value, store) => {
        if (key === 'capacity_enabled') {
          markEnableStarted();
          await enableWrite;
        }
        store[key] = value;
      },
    );
    await capacity.loadCapacitySettings();
    const cap = document.querySelector('#settings-capacity-enabled') as HTMLElement & { selected: boolean };
    const grid = document.querySelector('#settings-grid-import-enabled') as HTMLElement & { selected: boolean };
    cap.selected = true;
    grid.selected = false;
    const save = capacity.saveSettingsLimitsSettings();
    await enableStarted;

    // A realtime refresh reads the store mid-save, then waits on the power read.
    const power = await import('../src/ui/power.ts');
    let releasePowerRead!: () => void;
    let markPowerReadStarted!: () => void;
    const powerReadStarted = new Promise<void>((resolve) => { markPowerReadStarted = resolve; });
    const powerReadGate = new Promise<void>((resolve) => { releasePowerRead = resolve; });
    const settledRead = await power.getPowerReadModel();
    vi.mocked(power.getPowerReadModel).mockImplementationOnce(async () => {
      markPowerReadStarted();
      await powerReadGate;
      return settledRead;
    });
    const staleLoad = capacity.loadCapacitySettings();
    await powerReadStarted;

    releaseEnable();
    await save;
    expect(settingsStore.capacity_enabled).toBe(true);
    expect(settingsStore.grid_import_enabled).toBe(false);
    releasePowerRead();
    await staleLoad;
    expect(cap.selected).toBe(true);
    expect(grid.selected).toBe(false);
  });

  it('shows a half-landed switch move when the running app cannot be read', async () => {
    buildLimitsDom();
    const { capacity, settingsStore } = await loadCapacityModuleWithWriter(
      { capacity_enabled: false, grid_import_enabled: true, grid_import_limit_kw: 3.3, capacity_period_minutes: 60 },
      new Error('power read failed'),
      { state: 'recorded', peakKw: 4.75 },
      async (key, value, store) => {
        if (key === 'grid_import_enabled') throw new Error('grid switch write failed');
        store[key] = value;
      },
    );
    await capacity.loadCapacitySettings();
    const cap = document.querySelector('#settings-capacity-enabled') as HTMLElement & { selected: boolean };
    const grid = document.querySelector('#settings-grid-import-enabled') as HTMLElement & { selected: boolean };
    cap.selected = true;
    grid.selected = false;
    await expect(capacity.saveSettingsLimitsSettings()).rejects.toThrow('grid switch write failed');
    expect(settingsStore.capacity_enabled).toBe(true);
    expect(settingsStore.grid_import_enabled).toBe(true);
    expect(cap.selected).toBe(true);
    expect(grid.selected).toBe(true);
  });

  it('does not write switch defaults the owner never set', async () => {
    const dom = buildLimitsDom();
    const { capacity, setSetting } = await loadCapacityModule({ capacity_period_minutes: 60 });
    await capacity.loadCapacitySettings();
    dom.margin.value = '0.6';
    await capacity.saveSettingsLimitsSettings();
    expect(setSetting.mock.calls).toEqual([['capacity_margin_kw', 0.6]]);
  });

  it('keeps the runtime control posture when one persisted control field is unreadable', async () => {
    buildLimitsDom();
    const { capacity } = await loadCapacityModule({
      capacity_enabled: false, grid_import_enabled: true, grid_import_limit_kw: undefined,
    });
    const power = await import('../src/ui/power.ts');
    vi.mocked(power.getPowerReadModel).mockResolvedValue({
      tracker: {}, readings: { state: 'never' },
      status: { state: 'unavailable', reason: 'no_measurement' },
      capacityPeak: { state: 'recorded', peakKw: 4.75 },
      capacityScalars: {
        state: 'resolved',
        scalars: { limitKw: 8, marginKw: 0.5, periodMinutes: 60, dryRun: true,
          capacityEnabled: true, gridImportLimitKw: 3.3 },
      },
      hardCapConfiguration: { state: 'resolved', configured: true },
    });
    await capacity.loadCapacitySettings();
    const cap = document.querySelector('#settings-capacity-enabled') as HTMLElement & { selected: boolean };
    const grid = document.querySelector('#settings-grid-import-enabled') as HTMLElement & { selected: boolean };
    expect(cap.selected).toBe(true);
    expect(grid.selected).toBe(true);
  });

  it('returns a failed enable switch to the confirmed posture without discarding typed values', async () => {
    const dom = buildLimitsDom();
    const { capacity } = await loadCapacityModule();
    const enabled = document.querySelector('#settings-capacity-enabled') as HTMLElement & { selected: boolean };
    enabled.selected = false;
    await capacity.saveSettingsLimitsSettings();
    enabled.selected = true;
    dom.limit.value = '8';
    dom.margin.value = '10';
    await expect(capacity.saveSettingsLimitsSettings()).rejects.toThrow(capacity.MARGIN_NOT_BELOW_LIMIT_MESSAGE);
    expect(enabled.selected).toBe(false);
    expect(dom.margin.value).toBe('10');
  });

  it('rejects a nonpositive enabled grid limit before writing either switch', async () => {
    const dom = buildLimitsDom();
    const { capacity, setSetting } = await loadCapacityModule();
    dom.limit.value = '8';
    dom.margin.value = '0.5';
    (document.querySelector('#settings-grid-import-enabled') as HTMLElement & { selected: boolean }).selected = true;
    (document.querySelector('#settings-grid-import-limit') as HTMLElement & { value: string }).value = '0';
    await expect(capacity.saveSettingsLimitsSettings()).rejects.toThrow('Grid import limit must be positive.');
    expect(setSetting).not.toHaveBeenCalled();
  });
  it('shows an alert when the margin meets or exceeds the hard cap', async () => {
    const dom = buildLimitsDom();
    const { capacity } = await loadCapacityModule();
    dom.limit.value = '8';
    dom.margin.value = '10';

    capacity.refreshLimitsValidationHints();

    expect(dom.alert.hidden).toBe(false);
    expect(dom.alert.textContent).toBe(capacity.MARGIN_NOT_BELOW_LIMIT_MESSAGE);
  });

  it('treats margin equal to the hard cap as invalid', async () => {
    const dom = buildLimitsDom();
    const { capacity } = await loadCapacityModule();
    dom.limit.value = '8';
    dom.margin.value = '8';

    capacity.refreshLimitsValidationHints();

    expect(dom.alert.hidden).toBe(false);
    expect(dom.alert.textContent).toBe(capacity.MARGIN_NOT_BELOW_LIMIT_MESSAGE);
  });

  it('hides the alert once the margin is below the hard cap', async () => {
    const dom = buildLimitsDom();
    const { capacity } = await loadCapacityModule();
    dom.limit.value = '8';
    dom.margin.value = '10';
    capacity.refreshLimitsValidationHints();
    expect(dom.alert.hidden).toBe(false);

    dom.margin.value = '0.5';
    capacity.refreshLimitsValidationHints();

    expect(dom.alert.hidden).toBe(true);
    expect(dom.alert.textContent).toBe('');
  });

  it('stays quiet while either field is empty or non-numeric', async () => {
    const dom = buildLimitsDom();
    const { capacity } = await loadCapacityModule();
    dom.limit.value = '8';
    dom.margin.value = '';

    capacity.refreshLimitsValidationHints();

    expect(dom.alert.hidden).toBe(true);
  });

  it('blocks the API call and surfaces the alert when saving an invalid pair', async () => {
    const dom = buildLimitsDom();
    const { capacity, setSetting } = await loadCapacityModule();
    dom.limit.value = '8';
    dom.margin.value = '10';

    await expect(capacity.saveSettingsLimitsSettings()).rejects.toThrow(
      capacity.MARGIN_NOT_BELOW_LIMIT_MESSAGE,
    );

    expect(setSetting).not.toHaveBeenCalled();
    expect(dom.alert.hidden).toBe(false);
    expect(dom.alert.textContent).toBe(capacity.MARGIN_NOT_BELOW_LIMIT_MESSAGE);
  });

  it('clears the alert after loadCapacitySettings restores persisted values', async () => {
    const dom = buildLimitsDom();
    const { capacity } = await loadCapacityModule({
      capacity_limit_kw: 8,
      capacity_margin_kw: 0.5,
    });
    dom.limit.value = '8';
    dom.margin.value = '10';
    capacity.refreshLimitsValidationHints();
    expect(dom.alert.hidden).toBe(false);

    await capacity.loadCapacitySettings();

    expect(dom.alert.hidden).toBe(true);
    expect(dom.limit.value).toBe('8');
    expect(dom.margin.value).toBe('0.5');
  });

  it('loads and saves the Belgian capacity period', async () => {
    const dom = buildLimitsDom();
    const { capacity, setSetting } = await loadCapacityModule({ capacity_period_minutes: 15 });

    await capacity.loadCapacitySettings();
    expect(dom.period.value).toBe('15');
    expect(document.querySelector('#settings-capacity-monthly-peak')?.hasAttribute('hidden')).toBe(false);
    expect(document.querySelector('#settings-capacity-monthly-peak-value')?.textContent).toBe('4.75 kW');

    dom.period.value = '60';
    await capacity.saveSettingsLimitsSettings();
    expect(setSetting).toHaveBeenCalledWith('capacity_period_minutes', 60);
  });

  it('does not restore stale simulation state when an older limits save finishes last', async () => {
    const dom = buildLimitsDom();
    let releaseLimitWrite!: () => void;
    let markLimitWriteStarted!: () => void;
    const limitWriteStarted = new Promise<void>((resolve) => { markLimitWriteStarted = resolve; });
    const limitWrite = new Promise<void>((resolve) => { releaseLimitWrite = resolve; });
    const { capacity, settingsStore } = await loadCapacityModuleWithWriter(
      {},
      undefined,
      { state: 'recorded', peakKw: 4.75 },
      async (key, value, store) => {
        if (key === 'capacity_limit_kw') {
          markLimitWriteStarted();
          await limitWrite;
        }
        store[key] = value;
      },
    );
    await capacity.loadCapacitySettings();
    dom.limit.value = '12';
    dom.margin.value = '0.5';

    const limitsSave = capacity.saveSettingsLimitsSettings();
    await limitWriteStarted;
    await capacity.saveSimulationModeSettings(false);
    releaseLimitWrite();
    await limitsSave;

    const simulation = document.querySelector('#settings-simulation-mode') as HTMLElement & { selected: boolean };
    expect(simulation.selected).toBe(false);
    expect(settingsStore.capacity_dry_run).toBe(false);
    expect(dom.limit.value).toBe('12');
  });

  it('does not restore stale limits when an older simulation save finishes last', async () => {
    const dom = buildLimitsDom();
    let releaseSimulationWrite!: () => void;
    let markSimulationWriteStarted!: () => void;
    const simulationWriteStarted = new Promise<void>((resolve) => { markSimulationWriteStarted = resolve; });
    const simulationWrite = new Promise<void>((resolve) => { releaseSimulationWrite = resolve; });
    const { capacity, settingsStore } = await loadCapacityModuleWithWriter(
      {},
      undefined,
      { state: 'recorded', peakKw: 4.75 },
      async (key, value, store) => {
        if (key === 'capacity_dry_run') {
          markSimulationWriteStarted();
          await simulationWrite;
        }
        store[key] = value;
      },
    );
    await capacity.loadCapacitySettings();

    const simulationSave = capacity.saveSimulationModeSettings(false);
    await simulationWriteStarted;
    dom.limit.value = '12';
    dom.margin.value = '0.5';
    await capacity.saveSettingsLimitsSettings();
    releaseSimulationWrite();
    await simulationSave;

    expect(dom.limit.value).toBe('12');
    expect(settingsStore.capacity_limit_kw).toBe(12);
    const simulation = document.querySelector('#settings-simulation-mode') as HTMLElement & { selected: boolean };
    expect(simulation.selected).toBe(false);
  });

  it('keeps valid Belgian settings visible when the optional peak read fails', async () => {
    const dom = buildLimitsDom();
    const { capacity } = await loadCapacityModule(
      { capacity_period_minutes: 15 },
      new Error('peak read failed'),
    );

    await expect(capacity.loadCapacitySettings()).resolves.toBeUndefined();

    expect(dom.period.value).toBe('15');
    expect(dom.limit.value).toBe('8');
    expect(document.querySelector('#settings-capacity-monthly-peak-value')?.textContent)
      .toBe('Peak unavailable');
  });

  it('keeps legacy settings visible when runtime capacity state is unavailable', async () => {
    const dom = buildLimitsDom();
    const { capacity } = await loadCapacityModule({}, new Error('power read failed'));

    await expect(capacity.loadCapacitySettings()).resolves.toBeUndefined();

    expect(dom.limit.value).toBe('8');
    expect(dom.margin.value).toBe('0.5');
    expect(dom.period.value).toBe('60');
    expect(document.querySelector('#settings-capacity-monthly-peak')?.hasAttribute('hidden')).toBe(true);
  });

});
