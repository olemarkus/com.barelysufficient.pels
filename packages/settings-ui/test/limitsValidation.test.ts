// Unit coverage for the inline margin/hard-cap validation hint in Limits & safety.
// Verifies that the alert text appears as soon as the user enters an invalid
// pair, that it clears once the pair becomes valid, and that the save path
// blocks the API call without silently snapping the field back.

const LIMITS_FORM_TEMPLATE = [
  '<form id="settings-limits-form">',
  '<md-filled-text-field id="settings-capacity-limit"></md-filled-text-field>',
  '<md-filled-text-field id="settings-capacity-margin"></md-filled-text-field>',
  '<span id="settings-capacity-reaction"></span>',
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
  limit.value = '';
  margin.value = '';
  powerSource.value = 'flow';
  return {
    limit,
    margin,
    powerSource,
    alert: document.querySelector('#settings-capacity-margin-alert') as HTMLElement,
  };
};

const loadCapacityModule = async (settings: Record<string, unknown> = {}) => {
  vi.resetModules();
  const settingsStore: Record<string, unknown> = {
    capacity_limit_kw: 8,
    capacity_margin_kw: 0.5,
    capacity_dry_run: true,
    power_source: 'flow',
    ...settings,
  };
  const setSetting = vi.fn().mockResolvedValue(undefined);
  const getSetting = vi.fn().mockImplementation(async (key: string) => settingsStore[key]);
  vi.doMock('../src/ui/homey.ts', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../src/ui/homey.ts')>();
    return {
      ...actual,
      setSetting,
      getSetting,
    };
  });
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
});
