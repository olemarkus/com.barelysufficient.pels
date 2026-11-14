import type { SettingsUiDeviceSnapshot } from '../../contracts/src/settingsUi/devices';
import {
  SETTINGS_UI_BOOTSTRAP_PATH,
  SETTINGS_UI_SMART_TASK_DEVICES_PATH,
} from '../../contracts/src/settingsUi/paths';
import { EV_CHARGING_SESSION_SMOOTHING } from '../../shared-domain/src/settings/settingsKeys';
import { withDescriptorIdentity } from './helpers/deviceSnapshotFixture';

const getSetting = vi.fn();
const getSettingFresh = vi.fn();
const setSetting = vi.fn();
const callApi = vi.fn();
const getPrices = vi.fn();
vi.mock('../src/ui/prices.ts', () => ({ getPricesReadModel: () => getPrices() }));
vi.mock('../src/ui/homey.ts', async () => ({
  ...await vi.importActual<typeof import('../src/ui/homey.ts')>('../src/ui/homey.ts'),
  getSetting: (...args: unknown[]) => getSetting(...args),
  getSettingFresh: (...args: unknown[]) => getSettingFresh(...args),
  setSetting: (...args: unknown[]) => setSetting(...args),
  callApi: (...args: unknown[]) => callApi(...args),
}));
vi.mock('../src/ui/toast.ts', () => ({ showToast: vi.fn(), showToastError: vi.fn() }));
vi.mock('../src/ui/logging.ts', () => ({ logSettingsError: vi.fn() }));

const DEVICE_ID = 'garage-charger';
type TestSwitch = HTMLElement & { selected: boolean; disabled: boolean };
const toggle = (): TestSwitch => document.getElementById('device-detail-charging-session-smoothing-enabled') as TestSwitch;
const row = (): HTMLElement => document.getElementById('device-detail-charging-session-smoothing')!;
const flush = () => new Promise<void>((resolve) => { setTimeout(resolve, 0); });

const device = (isEvCharger = true): SettingsUiDeviceSnapshot => withDescriptorIdentity<SettingsUiDeviceSnapshot>({
  id: DEVICE_ID, name: 'Garage charger', available: true,
  targets: [], expectedPowerKw: 7, expectedPowerSource: 'default',
  deviceClass: isEvCharger ? 'evcharger' : 'socket', isEvCharger,
  binaryControllable: true, binaryControl: { on: false },
});

const load = async (options: { candidate?: boolean; isEvCharger?: boolean; managed?: boolean } = {}) => {
  const { state } = await import('../src/ui/state.ts');
  const shownDevice = device(options.isEvCharger ?? true);
  state.latestDevices = [shownDevice];
  state.managedMap = { [DEVICE_ID]: options.managed ?? true };
  state.evChargingSessionSmoothingSettings = {};
  callApi.mockImplementation(async (_method: string, path: string) => {
    if (path === SETTINGS_UI_SMART_TASK_DEVICES_PATH) {
      return { state: 'ready', devices: options.candidate === false ? [] : [{ deviceId: DEVICE_ID }] };
    }
    if (path === SETTINGS_UI_BOOTSTRAP_PATH) return { settings: { [EV_CHARGING_SESSION_SMOOTHING]: {} } };
    throw new Error(`Unexpected API route ${path}`);
  });
  const subject = await import('../src/ui/deviceDetail/evChargingSessionSmoothing.ts');
  const refresh = vi.fn(() => { void subject.renderEvChargingSessionSmoothing(shownDevice); });
  subject.initEvChargingSessionSmoothingHandlers({
    getCurrentDetailDeviceId: () => DEVICE_ID,
    refreshOpenDeviceDetail: refresh,
  });
  await subject.renderEvChargingSessionSmoothing(shownDevice);
  await flush();
  return { subject, state, refresh, device: shownDevice };
};

const change = async (enabled: boolean): Promise<void> => {
  toggle().selected = enabled;
  toggle().dispatchEvent(new Event('change'));
  await flush();
};

describe('per-charger charging session smoothing opt-in', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.resetAllMocks();
    getPrices.mockResolvedValue({ priceTimeline: { state: 'ready', periods: [{ durationMinutes: 15 }] } });
    getSetting.mockResolvedValue(null);
    getSettingFresh.mockResolvedValue({});
    setSetting.mockResolvedValue(undefined);
    document.body.innerHTML = `
      <div id="device-detail-charging-session-smoothing" hidden>
        <md-switch id="device-detail-charging-session-smoothing-enabled"></md-switch>
      </div>
    `;
  });

  it('offers the setting off by default after the server admits the charger for smart tasks', async () => {
    await load();
    expect(callApi).toHaveBeenCalledWith('GET', SETTINGS_UI_SMART_TASK_DEVICES_PATH);
    expect(row().hidden).toBe(false);
    expect(toggle().selected).toBe(false);
    expect(toggle().disabled).toBe(false);
    expect(setSetting).not.toHaveBeenCalled();
  });

  it.each([
    { isEvCharger: false }, { candidate: false }, { managed: false },
  ])('hides the setting for an ineligible device: %j', async (options) => {
    await load(options);
    expect(row().hidden).toBe(true);
  });

  it('hides the setting while candidate eligibility is unavailable', async () => {
    const { subject, device: shownDevice } = await load();
    const { hideDeviceSmartTaskBox } = await import('../src/ui/deviceDetail/smartTaskBox.ts');
    hideDeviceSmartTaskBox();
    callApi.mockRejectedValueOnce(new Error('Homey unavailable'));
    await subject.renderEvChargingSessionSmoothing(shownDevice);
    await flush();
    expect(row().hidden).toBe(true);
  });

  it.each([
    { state: 'ready', periods: [{ durationMinutes: 60 }] },
    { state: 'ready', periods: [] },
    { state: 'unavailable', reason: 'no_prices' },
  ])('hides even a saved opt-in without 15-minute pricing: %j', async (priceTimeline) => {
    const { subject, state, device: shownDevice } = await load();
    state.evChargingSessionSmoothingSettings = { [DEVICE_ID]: true };
    getPrices.mockResolvedValue({ priceTimeline });
    await subject.renderEvChargingSessionSmoothing(shownDevice);
    expect(row().hidden).toBe(true);
    await change(false);
    expect(setSetting).not.toHaveBeenCalled();
    expect(state.evChargingSessionSmoothingSettings[DEVICE_ID]).toBe(true);
  });

  it('hides the control when the price read fails', async () => {
    const { subject, device: shownDevice } = await load();
    getPrices.mockRejectedValue(new Error('Price read failed'));
    await subject.renderEvChargingSessionSmoothing(shownDevice);
    expect(row().hidden).toBe(true);
  });

  it('does not let an older quarter-hour response reveal the control after hourly prices', async () => {
    const { subject, device: shownDevice } = await load();
    let finish: (value: unknown) => void = () => {};
    getPrices.mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
    const older = subject.renderEvChargingSessionSmoothing(shownDevice);
    getPrices.mockResolvedValueOnce({ priceTimeline: { state: 'ready', periods: [{ durationMinutes: 60 }] } });
    await subject.renderEvChargingSessionSmoothing(shownDevice);
    finish({ priceTimeline: { state: 'ready', periods: [{ durationMinutes: 15 }] } });
    await older;
    expect(row().hidden).toBe(true);
  });

  it('reevaluates an open charger on price updates while preserving its saved choice', async () => {
    const { subject, state, device: shownDevice } = await load();
    state.evChargingSessionSmoothingSettings = { [DEVICE_ID]: true };
    await subject.renderEvChargingSessionSmoothing(shownDevice);
    getPrices.mockResolvedValue({ priceTimeline: { state: 'ready', periods: [{ durationMinutes: 60 }] } });
    document.dispatchEvent(new Event('prices-updated'));
    await flush();
    expect(row().hidden).toBe(true);
    getPrices.mockResolvedValue({ priceTimeline: { state: 'ready', periods: [{ durationMinutes: 15 }] } });
    document.dispatchEvent(new Event('prices-updated'));
    await flush();
    expect(row().hidden).toBe(false);
    expect(toggle().selected).toBe(true);
    expect(setSetting).not.toHaveBeenCalled();
  });

  it.each(['missing', 'unavailable'])('allows a saved opt-in to be disabled when eligibility is %s', async (eligibility) => {
    const { subject, state, device: shownDevice } = await load({ candidate: false });
    state.evChargingSessionSmoothingSettings = { [DEVICE_ID]: true, sibling: true };
    if (eligibility === 'unavailable') {
      const candidates = await import('../src/ui/deviceDetail/smartTaskBox.ts');
      candidates.hideDeviceSmartTaskBox();
      callApi.mockRejectedValueOnce(new Error('Homey unavailable'));
      candidates.isDeviceSmartTaskCandidate(DEVICE_ID);
      await flush();
    }
    await subject.renderEvChargingSessionSmoothing(shownDevice);
    expect(row().hidden).toBe(false);
    expect(toggle().selected).toBe(true);
    getSettingFresh.mockResolvedValue({ [DEVICE_ID]: true, sibling: true });
    await change(false);
    expect(setSetting).toHaveBeenCalledWith(EV_CHARGING_SESSION_SMOOTHING, { sibling: true });
    expect(row().hidden).toBe(true);
  });

  it('merges fresh sibling opt-ins, including chargers absent from the visible roster', async () => {
    const { state } = await load();
    state.evChargingSessionSmoothingSettings = { stale: true };
    getSettingFresh.mockResolvedValue({ 'hidden-charger': true, 'other-charger': true, 'disabled-charger': false });
    await change(true);

    expect(getSettingFresh).toHaveBeenCalledWith(EV_CHARGING_SESSION_SMOOTHING);
    expect(setSetting).toHaveBeenCalledWith(EV_CHARGING_SESSION_SMOOTHING, {
      'hidden-charger': true, 'other-charger': true, [DEVICE_ID]: true,
    });
    expect(state.evChargingSessionSmoothingSettings).toEqual({
      'hidden-charger': true, 'other-charger': true, [DEVICE_ID]: true,
    });
    expect(toggle().selected).toBe(true);
  });

  it('removes only this charger when turned off', async () => {
    const { state, subject, device: shownDevice } = await load();
    state.evChargingSessionSmoothingSettings = { [DEVICE_ID]: true, sibling: true };
    await subject.renderEvChargingSessionSmoothing(shownDevice);
    getSettingFresh.mockResolvedValue({ [DEVICE_ID]: true, sibling: true });
    await change(false);

    expect(setSetting).toHaveBeenCalledWith(EV_CHARGING_SESSION_SMOOTHING, { sibling: true });
    expect(toggle().selected).toBe(false);
  });

  it('uses complete bootstrap evidence after a null fresh read instead of the page snapshot', async () => {
    const { state } = await load();
    state.evChargingSessionSmoothingSettings = { stale: true };
    getSettingFresh.mockResolvedValue(null);
    callApi.mockResolvedValueOnce({ settings: { [EV_CHARGING_SESSION_SMOOTHING]: { 'hidden-charger': true } } });
    await change(true);

    expect(callApi).toHaveBeenCalledWith('GET', SETTINGS_UI_BOOTSTRAP_PATH);
    expect(setSetting).toHaveBeenCalledWith(EV_CHARGING_SESSION_SMOOTHING, {
      'hidden-charger': true, [DEVICE_ID]: true,
    });
  });

  it('requests new bootstrap evidence for every null-read save', async () => {
    await load();
    getSettingFresh.mockResolvedValue(null);
    callApi.mockResolvedValueOnce({ settings: { [EV_CHARGING_SESSION_SMOOTHING]: {} } });
    await change(true);
    callApi.mockResolvedValueOnce({ settings: { [EV_CHARGING_SESSION_SMOOTHING]: {
      [DEVICE_ID]: true, 'new-hidden-charger': true,
    } } });
    await change(false);

    expect(callApi.mock.calls.filter(([, path]) => path === SETTINGS_UI_BOOTSTRAP_PATH)).toHaveLength(2);
    expect(setSetting).toHaveBeenLastCalledWith(EV_CHARGING_SESSION_SMOOTHING, { 'new-hidden-charger': true });
  });

  it.each([
    null, {}, { settings: {} },
    { settings: { [EV_CHARGING_SESSION_SMOOTHING]: null } },
    { settings: { [EV_CHARGING_SESSION_SMOOTHING]: { sibling: 'malformed' } } },
  ])('does not save from missing or malformed complete bootstrap evidence: %j', async (bootstrap) => {
    const { state } = await load();
    state.evChargingSessionSmoothingSettings = { sibling: true };
    getSettingFresh.mockResolvedValue(null);
    callApi.mockResolvedValueOnce(bootstrap);
    await change(true);

    expect(setSetting).not.toHaveBeenCalled();
    expect(state.evChargingSessionSmoothingSettings).toEqual({ sibling: true });
    expect(toggle().selected).toBe(false);
  });

  it('does not save if bootstrap evidence is unavailable', async () => {
    await load();
    getSettingFresh.mockResolvedValue(null);
    callApi.mockRejectedValueOnce(new Error('Homey unavailable'));
    await change(true);
    expect(setSetting).not.toHaveBeenCalled();
    expect(toggle().selected).toBe(false);
  });

  it('rejects a malformed fresh map without replacing it with cached state', async () => {
    const { state } = await load();
    state.evChargingSessionSmoothingSettings = { sibling: true };
    getSettingFresh.mockResolvedValue({ sibling: 'malformed' });
    await change(true);
    expect(setSetting).not.toHaveBeenCalled();
    expect(callApi.mock.calls.some(([, path]) => path === SETTINGS_UI_BOOTSTRAP_PATH)).toBe(false);
    expect(state.evChargingSessionSmoothingSettings).toEqual({ sibling: true });
  });

  it('keeps the previous opt-in and redraws it when saving fails', async () => {
    const { state, subject, device: shownDevice } = await load();
    state.evChargingSessionSmoothingSettings = { [DEVICE_ID]: true, sibling: true };
    await subject.renderEvChargingSessionSmoothing(shownDevice);
    getSettingFresh.mockResolvedValue({ [DEVICE_ID]: true, sibling: true });
    setSetting.mockRejectedValueOnce(new Error('Save failed'));
    await change(false);

    expect(state.evChargingSessionSmoothingSettings).toEqual({ [DEVICE_ID]: true, sibling: true });
    expect(toggle().selected).toBe(true);
  });

  it('reflects later setting loads and keeps known state across transient null reads', async () => {
    const { subject, state, device: shownDevice } = await load();
    getSetting.mockResolvedValueOnce({ [DEVICE_ID]: true, malformed: 'ignored' });
    await subject.loadEvChargingSessionSmoothingSettings();
    await subject.renderEvChargingSessionSmoothing(shownDevice);
    expect(state.evChargingSessionSmoothingSettings).toEqual({ [DEVICE_ID]: true });
    expect(toggle().selected).toBe(true);

    getSetting.mockResolvedValueOnce(null);
    await subject.loadEvChargingSessionSmoothingSettings();
    await subject.renderEvChargingSessionSmoothing(shownDevice);
    expect(toggle().selected).toBe(true);

    getSetting.mockResolvedValueOnce({});
    await subject.loadEvChargingSessionSmoothingSettings();
    await subject.renderEvChargingSessionSmoothing(shownDevice);
    expect(toggle().selected).toBe(false);
  });
});
