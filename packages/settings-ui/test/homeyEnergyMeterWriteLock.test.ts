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

/** Drain pending microtasks (a macrotask turn) so settled handlers finish. */
const flushAsync = async (): Promise<void> => new Promise((done) => { setTimeout(done, 0); });

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
  ERROR_DURATION_MS: 5000,
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

  it('releases the picker before the refusal dwell so another meter can be picked at once', async () => {
    const refusalDwell = defer<void>();
    const secondSave = defer<{ ok: true }>();
    callApiMock
      .mockResolvedValueOnce({ ok: false, reason: 'meter_in_use', otherName: 'Cabin' })
      .mockImplementationOnce(() => secondSave.promise);
    showToastMock.mockImplementationOnce(() => refusalDwell.promise);
    const { initHomeyEnergyMeterHandlers } = await import('../src/ui/homeyEnergyMeter.ts');
    const select = selectElement();
    initHomeyEnergyMeterHandlers();

    select.value = 'meter-a';
    select.dispatchEvent(new Event('change'));

    // The refusal toast is up (its five-second dwell is still pending) and the
    // picker is already usable again, rolled back to the confirmed selection —
    // the toast tells the owner to pick another meter, so the select must not
    // stay gated for the dwell.
    await vi.waitFor(() => { expect(showToastMock).toHaveBeenCalledOnce(); });
    expect(select.disabled).toBe(false);
    expect(select.value).toBe('');

    // Acting on that instruction DURING the dwell starts the next write.
    select.value = 'meter-b';
    select.dispatchEvent(new Event('change'));
    expect(select.disabled).toBe(true);
    expect(callApiMock).toHaveBeenCalledTimes(2);
    expect(callApiMock).toHaveBeenLastCalledWith(
      'POST',
      SETTINGS_UI_HOMES_SAVE_PATH,
      { op: 'set_main_meter', meterDeviceId: 'meter-b' },
    );

    // The first handler's dwell ending must not un-gate the lock the second
    // write now owns: the flag guards the write in flight, not one handler.
    refusalDwell.resolve();
    await flushAsync();
    expect(select.disabled).toBe(true);

    secondSave.resolve({ ok: true });
    await vi.waitFor(() => {
      expect(select.disabled).toBe(false);
      expect(select.value).toBe('meter-b');
    });
    expect(applySettingsPatchMock).toHaveBeenCalledWith({
      [HOMEY_ENERGY_METER_DEVICE_ID]: 'meter-b',
    });
  });

  it('explains a refused Automatic selection instead of a generic failure', async () => {
    callApiMock
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ ok: false, reason: 'main_meter_required' });
    const { initHomeyEnergyMeterHandlers } = await import('../src/ui/homeyEnergyMeter.ts');
    const select = selectElement();
    initHomeyEnergyMeterHandlers();
    // Start from a confirmed explicit meter so Automatic is a real change.
    select.value = 'meter-a';
    select.dispatchEvent(new Event('change'));
    await vi.waitFor(() => { expect(select.disabled).toBe(false); });
    applySettingsPatchMock.mockClear();

    select.value = '';
    select.dispatchEvent(new Event('change'));

    await vi.waitFor(() => {
      expect(showToastMock).toHaveBeenCalledWith(
        'While meter areas exist, the Main home needs its own meter. '
        + 'Pick one, or remove your areas under Multiple meters first.',
        'warn',
        // Error dwell, not the 1.8 s acknowledgement default: a two-sentence
        // instruction is unreadable at that speed, and a typed refusal is not
        // an Error so `showToastError` (which applies it) does not fit.
        { durationMs: 5000 },
      );
    });
    expect(callApiMock).toHaveBeenLastCalledWith(
      'POST',
      SETTINGS_UI_HOMES_SAVE_PATH,
      { op: 'set_main_meter', meterDeviceId: null },
    );
    // Refused: the confirmed selection stands and nothing is patched.
    expect(applySettingsPatchMock).not.toHaveBeenCalled();
    expect(select.value).toBe('meter-a');
  });
});
