import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { SETTINGS_UI_HOMES_SAVE_PATH } from '../../contracts/src/settingsUiHomes.ts';
import { HOMEY_ENERGY_METER_DEVICE_ID } from '../../contracts/src/settingsKeys.ts';

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
};

const defer = <T>(): Deferred<T> => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
};

const callApiMock = vi.fn();
const applySettingsPatchMock = vi.fn();
const showToastMock = vi.fn().mockResolvedValue(undefined);
const showToastErrorMock = vi.fn().mockResolvedValue(undefined);
const logSettingsErrorMock = vi.fn().mockResolvedValue(undefined);

vi.mock('../src/ui/homey.ts', () => ({
  callApi: (...args: unknown[]) => callApiMock(...args),
  applySettingsPatch: (...args: unknown[]) => applySettingsPatchMock(...args),
}));
vi.mock('../src/ui/toast.ts', () => ({
  showToast: (...args: unknown[]) => showToastMock(...args),
  showToastError: (...args: unknown[]) => showToastErrorMock(...args),
}));
vi.mock('../src/ui/logging.ts', () => ({
  logSettingsError: (...args: unknown[]) => logSettingsErrorMock(...args),
}));

type TestSelect = HTMLElement & {
  value: string;
  disabled: boolean;
  open: boolean;
};

const selectElement = (): TestSelect => (
  document.querySelector('#settings-homey-energy-meter') as TestSelect
);

beforeEach(() => {
  vi.resetModules();
  document.body.innerHTML = [
    '<div id="settings-homey-energy-meter-field">',
    '  <div id="settings-homey-energy-meter"></div>',
    '</div>',
  ].join('');
  const select = selectElement();
  select.value = '';
  select.disabled = false;
  select.open = false;
});

afterEach(() => {
  document.body.innerHTML = '';
  vi.clearAllMocks();
});

describe('Whole-home meter write lock', () => {
  it('blocks an overlapping change and rolls a later failed save back to the confirmed success', async () => {
    const firstSave = defer<{ ok: true }>();
    callApiMock
      .mockImplementationOnce(() => firstSave.promise)
      .mockRejectedValueOnce(new Error('transport unavailable'));
    const { initHomeyEnergyMeterHandlers } = await import('../src/ui/homeyEnergyMeter.ts');
    const select = selectElement();
    initHomeyEnergyMeterHandlers();

    select.value = 'meter-a';
    select.dispatchEvent(new Event('change'));
    expect(select.disabled).toBe(true);
    expect(callApiMock).toHaveBeenCalledWith(
      'POST',
      SETTINGS_UI_HOMES_SAVE_PATH,
      { op: 'set_main_meter', meterDeviceId: 'meter-a' },
    );

    // A disabled Material select cannot produce this through normal input, but
    // the synchronous handler gate also rejects a programmatic overlap.
    select.value = 'meter-b';
    select.dispatchEvent(new Event('change'));
    expect(callApiMock).toHaveBeenCalledTimes(1);

    firstSave.resolve({ ok: true });
    await vi.waitFor(() => {
      expect(select.disabled).toBe(false);
      expect(select.value).toBe('meter-a');
    });
    expect(applySettingsPatchMock).toHaveBeenCalledWith({
      [HOMEY_ENERGY_METER_DEVICE_ID]: 'meter-a',
    });

    // Once the first write is confirmed, a later failure rolls back to A—not
    // the Automatic value captured before that successful write.
    select.value = 'meter-b';
    select.dispatchEvent(new Event('change'));
    await vi.waitFor(() => {
      expect(select.disabled).toBe(false);
      expect(select.value).toBe('meter-a');
    });
    expect(callApiMock).toHaveBeenCalledTimes(2);
    expect(showToastErrorMock).toHaveBeenCalledOnce();
  });
});
