import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HOMEY_ENERGY_METERS_PATH } from '../../contracts/src/settingsUiApi.ts';
import {
  WHOLE_HOME_METER_HINT,
  WHOLE_HOME_METER_NONE_FOUND_HINT,
} from '../../shared-domain/src/homeAreaConfigRulesCopy.ts';

/* -------------------------------------------------------------------------- *
 * The whole-home meter picker refetches its list on every sync: an empty
 * answer names the remedy but is never the last word (a meter paired in Homey
 * shows on the next sync), and a failed fetch keeps the last good list.
 * -------------------------------------------------------------------------- */

const callApiMock = vi.fn();

vi.mock('../src/ui/homey.ts', () => ({
  callApi: (...args: unknown[]) => callApiMock(...args),
  applySettingsPatch: vi.fn(),
}));
vi.mock('../src/ui/toast.ts', () => ({
  showToast: vi.fn().mockResolvedValue(undefined),
  showToastError: vi.fn().mockResolvedValue(undefined),
  ERROR_DURATION_MS: 5000,
}));
vi.mock('../src/ui/logging.ts', () => ({
  logSettingsError: vi.fn().mockResolvedValue(undefined),
}));

const flushAsync = async (): Promise<void> => new Promise((done) => { setTimeout(done, 0); });

const hintText = (): string | null => document.querySelector('#settings-homey-energy-meter-hint')!.textContent;
const optionValues = (): string[] => [...document.querySelectorAll('#settings-homey-energy-meter md-select-option')]
  .map((option) => option.getAttribute('value') ?? '');

beforeEach(() => {
  vi.resetModules();
  document.body.innerHTML = [
    '<div id="settings-homey-energy-meter-field">',
    '  <div id="settings-homey-energy-meter"></div>',
    '  <small id="settings-homey-energy-meter-hint"></small>',
    '</div>',
  ].join('');
  (document.querySelector('#settings-homey-energy-meter') as HTMLElement & { open: boolean }).open = false;
});

afterEach(() => {
  document.body.innerHTML = '';
  vi.clearAllMocks();
});

describe('whole-home meter picker list', () => {
  it('shows a meter paired after an empty answer on the next sync', async () => {
    callApiMock.mockResolvedValueOnce([]).mockResolvedValueOnce([{ id: 'han', name: 'HAN meter' }]);
    const { syncHomeyEnergyMeterVisibility } = await import('../src/ui/homeyEnergyMeter.ts');

    syncHomeyEnergyMeterVisibility('homey_energy');
    await flushAsync();
    expect(hintText()).toBe(WHOLE_HOME_METER_NONE_FOUND_HINT);

    syncHomeyEnergyMeterVisibility('homey_energy');
    await flushAsync();
    expect(callApiMock).toHaveBeenLastCalledWith('GET', HOMEY_ENERGY_METERS_PATH);
    expect(optionValues()).toContain('han');
    expect(hintText()).toBe(WHOLE_HOME_METER_HINT);
  });

  it('keeps the last good list when a later fetch fails', async () => {
    callApiMock
      .mockResolvedValueOnce([{ id: 'han', name: 'HAN meter' }])
      .mockRejectedValueOnce(new Error('Homey Energy live report lists no devices yet'));
    const { syncHomeyEnergyMeterVisibility } = await import('../src/ui/homeyEnergyMeter.ts');

    syncHomeyEnergyMeterVisibility('homey_energy');
    await flushAsync();
    syncHomeyEnergyMeterVisibility('homey_energy');
    await flushAsync();
    expect(callApiMock).toHaveBeenCalledTimes(2);
    expect(optionValues()).toContain('han');
    expect(hintText()).toBe(WHOLE_HOME_METER_HINT);
  });
});
