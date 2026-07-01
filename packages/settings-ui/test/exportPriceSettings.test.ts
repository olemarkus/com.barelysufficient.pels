import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

// The extra homey exports (callApi/getApiReadModel/primeApiCache/
// getHomeyTimezone) exist for the scheme-change tests below, which import
// the priceConfig orchestrator; Material Web registration is stubbed out so
// the md-* elements stay plain unknown elements with expando props. The mock
// objects are hoisted so `vi.resetModules()` (needed for a fresh priceConfig
// module instance per scheme-change test) keeps handing out the SAME fn
// instances the assertions reference.
const homeyMocks = vi.hoisted(() => ({
  getSetting: vi.fn(),
  setSetting: vi.fn(),
  callApi: vi.fn(),
  getApiReadModel: vi.fn(),
  primeApiCache: vi.fn(),
  getHomeyTimezone: vi.fn(() => 'UTC'),
}));
const toastMocks = vi.hoisted(() => ({
  showToast: vi.fn(),
  showToastError: vi.fn(),
}));
const loggingMocks = vi.hoisted(() => ({
  logSettingsError: vi.fn(),
}));
vi.mock('../src/ui/homey.ts', () => homeyMocks);
vi.mock('../src/ui/toast.ts', () => toastMocks);
vi.mock('../src/ui/logging.ts', () => loggingMocks);
vi.mock('../src/ui/materialWeb.ts', () => ({}));

import { getApiReadModel, getSetting, setSetting } from '../src/ui/homey.ts';
import { showToast, showToastError } from '../src/ui/toast.ts';
import {
  createExportPriceHandlers,
  resolveExportSchemeChangePlan,
  EXPORT_DISABLED_ON_SCHEME_CHANGE_TOAST,
  EXPORT_SHARE_NORMALIZED_TOAST,
  type ExportPriceHandlersContext,
} from '../src/ui/exportPriceSettings.ts';

const setSettingMock = setSetting as Mock;
const getSettingMock = getSetting as Mock;
const getApiReadModelMock = getApiReadModel as Mock;

type HandlerState = ReturnType<ExportPriceHandlersContext['getState']>;

const buildContext = (overrides: Partial<HandlerState> = {}) => {
  let state: HandlerState = {
    priceScheme: 'norway',
    exportPriceEnabled: false,
    exportSpotFactor: 90,
    exportFixed: -5,
    ...overrides,
  };
  const patchState = vi.fn((patch: Partial<HandlerState>) => {
    state = { ...state, ...patch };
  });
  const rerender = vi.fn();
  const ctx: ExportPriceHandlersContext = {
    getState: () => state,
    patchState,
    rerender,
  };
  return { ctx, patchState, rerender, getState: () => state };
};

beforeEach(() => {
  vi.clearAllMocks();
  setSettingMock.mockResolvedValue(undefined);
});

describe('createExportPriceHandlers — onEnabledChange', () => {
  it('writes the enabled flag BEFORE the spot-share normalization (fail-safe ordering)', async () => {
    const { ctx } = buildContext({ priceScheme: 'flow', exportSpotFactor: 90 });
    await createExportPriceHandlers(ctx).onEnabledChange(true);
    // Enabling on a spot-less scheme normalizes the share to 0, but only after
    // the enabled write landed — a failure mid-sequence must leave the stored
    // share untouched rather than zeroing it under a half-applied toggle.
    expect(setSettingMock.mock.calls).toEqual([
      ['export_price_enabled', true],
      ['export_spot_factor', 0],
    ]);
  });

  it('does not touch the stored spot share on the norway scheme or when disabling', async () => {
    const norway = buildContext({ priceScheme: 'norway', exportSpotFactor: 90 });
    await createExportPriceHandlers(norway.ctx).onEnabledChange(true);
    expect(setSettingMock.mock.calls).toEqual([['export_price_enabled', true]]);

    setSettingMock.mockClear();
    const flowOff = buildContext({ priceScheme: 'flow', exportPriceEnabled: true, exportSpotFactor: 90 });
    await createExportPriceHandlers(flowOff.ctx).onEnabledChange(false);
    expect(setSettingMock.mock.calls).toEqual([['export_price_enabled', false]]);
  });

  it('rolls the optimistic patch back when the write fails so the switch never lies', async () => {
    setSettingMock.mockRejectedValue(new Error('boom'));
    const { ctx, rerender, getState } = buildContext({
      priceScheme: 'flow',
      exportPriceEnabled: false,
      exportSpotFactor: 90,
    });
    await createExportPriceHandlers(ctx).onEnabledChange(true);
    // Nothing persisted (the first write failed), so the pre-call state is
    // restored (enabled stays off, share stays 90) + repaint.
    expect(getState().exportPriceEnabled).toBe(false);
    expect(getState().exportSpotFactor).toBe(90);
    expect(rerender).toHaveBeenCalledTimes(2); // optimistic + rollback
    expect(showToastError).toHaveBeenCalled();
  });

  it('compensates a landed enabled-write when the normalization write fails (rollback succeeds)', async () => {
    // enabled=true lands, factor=0 fails, rollback enabled=false lands.
    setSettingMock
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('factor write failed'))
      .mockResolvedValueOnce(undefined);
    const { ctx, getState } = buildContext({
      priceScheme: 'flow',
      exportPriceEnabled: false,
      exportSpotFactor: 90,
    });
    await createExportPriceHandlers(ctx).onEnabledChange(true);
    // The compensating write rolled the persisted toggle back to its pre-call
    // value, so showing the pre-call UI state is truthful again.
    expect(setSettingMock.mock.calls).toEqual([
      ['export_price_enabled', true],
      ['export_spot_factor', 0],
      ['export_price_enabled', false],
    ]);
    expect(getState().exportPriceEnabled).toBe(false);
    expect(getState().exportSpotFactor).toBe(90);
    expect(showToastError).toHaveBeenCalled();
  });

  it('shows the state that actually persisted when the compensating rollback also fails', async () => {
    // enabled=true lands, factor=0 fails, rollback enabled=false ALSO fails:
    // persisted = {enabled: true, factor: 90} — the UI must show that, not the
    // pre-call state the store no longer holds.
    setSettingMock
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('factor write failed'))
      .mockRejectedValueOnce(new Error('rollback write failed'));
    const { ctx, getState, rerender } = buildContext({
      priceScheme: 'flow',
      exportPriceEnabled: false,
      exportSpotFactor: 90,
    });
    await createExportPriceHandlers(ctx).onEnabledChange(true);
    expect(setSettingMock.mock.calls).toEqual([
      ['export_price_enabled', true],
      ['export_spot_factor', 0],
      ['export_price_enabled', false],
    ]);
    expect(getState().exportPriceEnabled).toBe(true);
    expect(getState().exportSpotFactor).toBe(90);
    expect(rerender).toHaveBeenCalledTimes(2); // optimistic + truthful repaint
    expect(showToastError).toHaveBeenCalled();
  });
});

describe('createExportPriceHandlers — numeric saves', () => {
  const field = () => ({ value: '250' });

  it('commits to config state only AFTER the write lands', async () => {
    const { ctx, patchState } = buildContext();
    let patchedAtWriteTime = false;
    setSettingMock.mockImplementation(async () => {
      patchedAtWriteTime = patchState.mock.calls.length > 0;
    });
    await createExportPriceHandlers(ctx).onSpotFactorChange(85, { value: '85' });
    expect(patchedAtWriteTime).toBe(false);
    expect(patchState).toHaveBeenCalledWith({ exportSpotFactor: 85 });
  });

  it('leaves config state untouched and snaps the field back when the write fails', async () => {
    setSettingMock.mockRejectedValue(new Error('boom'));
    const { ctx, patchState, rerender } = buildContext({ exportFixed: -5 });
    const el = { value: '12' };
    await createExportPriceHandlers(ctx).onFixedChange(12, el);
    expect(patchState).not.toHaveBeenCalled();
    // Snap-back writes the stored value onto the element (Preact's retained
    // VDOM won't rewrite an unchanged value prop) before the repaint.
    expect(el.value).toBe('-5');
    expect(rerender).toHaveBeenCalledTimes(1);
    expect(showToastError).toHaveBeenCalled();
  });

  it('rejects out-of-range input before any write and reverts the field', async () => {
    const { ctx, patchState } = buildContext({ exportSpotFactor: 90 });
    const el = field();
    await createExportPriceHandlers(ctx).onSpotFactorChange(250, el);
    expect(setSettingMock).not.toHaveBeenCalled();
    expect(patchState).not.toHaveBeenCalled();
    expect(el.value).toBe('90');
    expect(showToastError).toHaveBeenCalled();
  });
});

describe('resolveExportSchemeChangePlan', () => {
  const base = { exportPriceEnabled: true, exportSpotFactor: 90, exportFixed: -5 };

  it('never acts on the norway scheme or when export pricing is off', () => {
    expect(resolveExportSchemeChangePlan({ nextScheme: 'norway', ...base })).toBe('none');
    expect(resolveExportSchemeChangePlan({ nextScheme: 'flow', ...base, exportPriceEnabled: false })).toBe('none');
  });

  it('disables export when a fixed amount would cross the unit boundary', () => {
    // øre/kWh (divisor 100) does not translate into the flow/homey source
    // unit (divisor 1) — the fixed-amount case must turn export off, even
    // when a share is also set.
    expect(resolveExportSchemeChangePlan({ nextScheme: 'flow', ...base })).toBe('disable_export');
    expect(resolveExportSchemeChangePlan({ nextScheme: 'homey', ...base, exportSpotFactor: 0 })).toBe('disable_export');
  });

  it('normalizes a pure share config (fixed 0) to the fixed-tariff case', () => {
    expect(resolveExportSchemeChangePlan({ nextScheme: 'flow', ...base, exportFixed: 0 })).toBe('normalize_share');
  });

  it('does nothing for an already-settled config', () => {
    expect(resolveExportSchemeChangePlan({
      nextScheme: 'flow', exportPriceEnabled: true, exportSpotFactor: 0, exportFixed: 0,
    })).toBe('none');
  });
});

describe('handleSchemeChange export transition (via priceConfig)', () => {
  beforeEach(() => {
    // Fresh priceConfig module per test: its config state, surface pointer,
    // and settingsLoaded latch are module-level. The hoisted mocks above keep
    // their identities across the reset.
    vi.resetModules();
  });
  afterEach(() => {
    document.body.replaceChildren();
  });

  const bootPricesView = async (stored: Record<string, unknown>) => {
    getSettingMock.mockImplementation(async (key: string) => stored[key]);
    getApiReadModelMock.mockResolvedValue(null);
    const { initElectricityPricesView } = await import('../src/ui/priceConfig.ts');
    const surface = document.createElement('div');
    document.body.appendChild(surface);
    await initElectricityPricesView(surface);
    return surface;
  };

  // With Material Web registration mocked out, md-filled-text-field is an
  // unknown element, so Preact writes `value` as an attribute rather than a
  // property — read whichever carries it.
  const factorValue = (surface: HTMLElement) => {
    const el = surface.querySelector('#electricity-prices-export-spot-factor') as (HTMLElement & { value?: string }) | null;
    return el?.value ?? el?.getAttribute('value') ?? null;
  };

  const switchScheme = (surface: HTMLElement, scheme: string) => {
    const select = surface.querySelector('#price-source-select') as HTMLElement & { value: string };
    select.value = scheme;
    select.dispatchEvent(new Event('change', { bubbles: true }));
  };

  it('a failed scheme save leaves the export config untouched (no premature writes or state)', async () => {
    // Stored config: Norway scheme, export enabled, share + fixed set.
    const surface = await bootPricesView({
      price_scheme: 'norway',
      export_price_enabled: true,
      export_spot_factor: 90,
      export_fixed: -5,
    });
    expect(factorValue(surface)).toBe('90');

    // Switch away from Norway while every settings write fails.
    setSettingMock.mockRejectedValue(new Error('save failed'));
    switchScheme(surface, 'flow');
    await vi.waitFor(() => expect(showToastError).toHaveBeenCalled());

    // Neither export follow-up write was attempted (they only run after the
    // scheme save lands) and the config state was never mutated — switching
    // back to Norway must show the untouched stored share, not 0 or off.
    expect(setSettingMock).not.toHaveBeenCalledWith('export_spot_factor', 0);
    expect(setSettingMock).not.toHaveBeenCalledWith('export_price_enabled', false);
    setSettingMock.mockResolvedValue(undefined);
    switchScheme(surface, 'norway');
    await vi.waitFor(() => expect(factorValue(surface)).toBe('90'));
  });

  it('leaving norway with a non-zero fixed amount turns export off and keeps the stored numbers', async () => {
    const surface = await bootPricesView({
      price_scheme: 'norway',
      export_price_enabled: true,
      export_spot_factor: 90,
      export_fixed: -5,
    });
    switchScheme(surface, 'flow');
    await vi.waitFor(() => expect(showToast).toHaveBeenCalledWith(EXPORT_DISABLED_ON_SCHEME_CHANGE_TOAST, 'ok'));

    // The disable write runs strictly AFTER the scheme save; the stored
    // numbers are kept inert (no share/fixed writes) so switching back to
    // Norway only needs a re-enable.
    const keys = setSettingMock.mock.calls.map((call) => call[0] as string);
    expect(setSettingMock).toHaveBeenCalledWith('export_price_enabled', false);
    expect(keys.indexOf('price_scheme')).toBeGreaterThanOrEqual(0);
    expect(keys.indexOf('price_scheme')).toBeLessThan(keys.indexOf('export_price_enabled'));
    expect(setSettingMock).not.toHaveBeenCalledWith('export_spot_factor', 0);
    expect(keys).not.toContain('export_fixed');
    // Toggle renders off → the fields are structurally absent.
    await vi.waitFor(() => expect(surface.querySelector('#electricity-prices-export-spot-factor')).toBeNull());
  });

  it('leaving norway with a pure share config normalizes the share to 0 after the scheme save', async () => {
    const surface = await bootPricesView({
      price_scheme: 'norway',
      export_price_enabled: true,
      export_spot_factor: 90,
      export_fixed: 0,
    });
    switchScheme(surface, 'flow');
    await vi.waitFor(() => expect(showToast).toHaveBeenCalledWith(EXPORT_SHARE_NORMALIZED_TOAST, 'ok'));

    const keys = setSettingMock.mock.calls.map((call) => call[0] as string);
    expect(setSettingMock).toHaveBeenCalledWith('export_spot_factor', 0);
    expect(keys.indexOf('price_scheme')).toBeLessThan(keys.indexOf('export_spot_factor'));
    expect(setSettingMock).not.toHaveBeenCalledWith('export_price_enabled', false);
    // Export stays on; the share settles at 0 (disabled fixed-only state).
    await vi.waitFor(() => expect(factorValue(surface)).toBe('0'));
  });
});
