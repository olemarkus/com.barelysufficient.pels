// Unit coverage for the inline margin/hard-cap validation hint in Limits & safety.
// Verifies that the alert text appears as soon as the user enters an invalid
// pair, that it clears once the pair becomes valid, and that the save path
// blocks the API call without silently snapping the field back.

import type { SettingsUiCapacityPeak } from '../../contracts/src/settingsUiApi.ts';

const LIMITS_FORM_TEMPLATE = [
  '<form id="settings-limits-form">',
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
      : vi.fn().mockResolvedValue({
        tracker: {},
        readings: { state: 'never' },
        status: { state: 'unavailable', reason: 'no_measurement' },
        capacityPeak,
        capacityScalars: { state: 'unavailable' },
        hardCapConfiguration: { state: 'unavailable' },
      }),
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
