import type { SettingsUiDeviceSnapshot } from '../../contracts/src/settingsUi/devices';
import { DEVICE_POWER_CONTROL_MODES } from '../../shared-domain/src/settings/settingsKeys.ts';
import { withDescriptorIdentity } from './helpers/deviceSnapshotFixture.ts';

const getSettingFresh = vi.fn();
const setSetting = vi.fn();
vi.mock('../src/ui/homey.ts', async () => ({
  ...await vi.importActual<typeof import('../src/ui/homey.ts')>('../src/ui/homey.ts'),
  getSettingFresh: (...args: unknown[]) => getSettingFresh(...args),
  setSetting: (...args: unknown[]) => setSetting(...args),
}));
vi.mock('../src/ui/toast.ts', () => ({ showToast: vi.fn(), showToastError: vi.fn() }));
vi.mock('../src/ui/logging.ts', () => ({ logSettingsError: vi.fn() }));

const profile = { steps: [
  { id: 'off', planningPowerW: 0 },
  { id: '2530w', planningPowerW: 2530 },
  { id: '12650w', planningPowerW: 12650 },
] };
const charger = (mode: 'automatic' | 'manual' = 'manual'): SettingsUiDeviceSnapshot => (
  withDescriptorIdentity<SettingsUiDeviceSnapshot>({
    id: 'garage', name: 'Garage charger', available: true,
    expectedPowerKw: 12.65, expectedPowerSource: 'default', targets: [],
    deviceClass: 'evcharger', deviceType: 'onoff', managed: true,
    automaticPowerControl: { mode, profile },
    controlAdapter: { kind: 'capability_adapter', activationEnabled: mode === 'automatic',
      activationRequired: false },
    targetPowerConfig: mode === 'manual' ? { enabled: true, preset: 'ev_charger_3_phase', max: 7360 } : undefined,
  })
);

type TestSelect = HTMLElement & { value: string; disabled: boolean };
type TestDialog = HTMLElement & { open: boolean; returnValue: string; show: () => void };
const selector = () => document.getElementById('device-detail-power-control-mode') as TestSelect;
const dialog = () => document.getElementById('power-control-confirm-dialog') as TestDialog;
const choose = (value: string): void => {
  selector().value = value;
  selector().dispatchEvent(new Event('change'));
};
const closeReview = (value = ''): void => {
  dialog().returnValue = value;
  dialog().open = false;
  dialog().dispatchEvent(new Event('close'));
};

const load = async (device = charger()) => {
  const { state } = await import('../src/ui/state.ts');
  state.latestDevices = [device];
  state.devicePowerControlModes = {};
  state.devicePowerControlModesLoaded = true;
  state.deviceTargetPowerConfigs = { [device.id]: { enabled: true, preset: 'ev_charger_3_phase', max: 7360 } };
  state.deviceControlProfiles = { [device.id]: { steps: [
    { id: 'off', planningPowerW: 0 }, { id: 'custom', planningPowerW: 7360 },
  ] } };
  const subject = await import('../src/ui/deviceDetail/automaticPowerControl.ts');
  const refresh = vi.fn(() => subject.renderAutomaticPowerControl(device));
  subject.initAutomaticPowerControlHandlers(() => device.id, refresh);
  subject.renderAutomaticPowerControl(device);
  return { state, subject, refresh, device };
};

describe('Automatic power control choice', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    getSettingFresh.mockResolvedValue({ other: 'manual' });
    setSetting.mockResolvedValue(undefined);
    document.body.innerHTML = `
      <div id="device-detail-power-control-row" hidden>
        <md-filled-select id="device-detail-power-control-mode"></md-filled-select>
        <small id="device-detail-power-control-hint"></small>
        <small id="device-detail-power-control-range"></small>
      </div>
      <md-dialog id="power-control-confirm-dialog">
        <p id="power-control-confirm-message"></p>
        <ul id="power-control-confirm-consequences"></ul>
      </md-dialog>
    `;
    const review = dialog();
    Object.assign(review, { open: false, returnValue: '', show: () => { review.open = true; } });
  });

  it('keeps the existing Manual setup and explains its replacement before switching', async () => {
    await load();
    expect(selector().value).toBe('manual');
    expect(document.getElementById('device-detail-power-control-row')?.hidden).toBe(false);
    expect(document.getElementById('device-detail-power-control-hint')?.textContent).toContain('manual setup below');
    expect(document.getElementById('device-detail-power-control-range')?.hidden).toBe(true);
    choose('automatic');

    expect(dialog().open).toBe(true);
    expect(selector().value).toBe('manual');
    expect(dialog().textContent).toContain('EV 3-phase model will not be used');
    expect(dialog().textContent).toContain('maximum of 7.36 kW will not apply');
    expect(dialog().textContent).toContain('2.53–12.65 kW');
    expect(dialog().textContent).toContain('manual charging-current setup will not be used');
    expect(setSetting).not.toHaveBeenCalled();
    closeReview('cancel');
  });

  it.each(['cancel', ''])('leaves Manual unchanged when review closes with %j', async (result) => {
    const { state } = await load();
    choose('automatic');
    expect(dialog().open).toBe(true);
    closeReview(result);
    await Promise.resolve();
    expect(selector().value).toBe('manual');
    expect(state.devicePowerControlModes).toEqual({});
    expect(setSetting).not.toHaveBeenCalled();
  });

  it('saves only the confirmed mode and retains manual configuration, other choices and dismissal', async () => {
    const { state, device, refresh } = await load();
    const manualConfig = structuredClone(state.deviceTargetPowerConfigs);
    const manualProfile = structuredClone(state.deviceControlProfiles);
    choose('automatic');
    closeReview('confirm');
    await vi.waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));

    expect(getSettingFresh).toHaveBeenCalledWith(DEVICE_POWER_CONTROL_MODES);
    expect(setSetting.mock.calls).toEqual([[DEVICE_POWER_CONTROL_MODES, { other: 'manual', garage: 'automatic' }]]);
    expect(state.devicePowerControlModes).toEqual({ other: 'manual', garage: 'automatic' });
    expect(state.deviceTargetPowerConfigs).toEqual(manualConfig);
    expect(state.deviceControlProfiles).toEqual(manualProfile);
    expect(device.automaticPowerControl?.mode).toBe('manual');
    expect(selector().value).toBe('automatic');
    expect(document.getElementById('device-detail-power-control-range')?.textContent)
      .toBe('Charging range: 2.53–12.65 kW');
  });

  it('returns to Manual without discarding its saved phase and maximum', async () => {
    const { state, refresh } = await load(charger('automatic'));
    choose('manual');
    expect(dialog().open).toBe(false);
    await vi.waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));

    expect(setSetting.mock.calls).toEqual([[DEVICE_POWER_CONTROL_MODES, { other: 'manual', garage: 'manual' }]]);
    expect(state.deviceTargetPowerConfigs.garage).toEqual({ enabled: true, preset: 'ev_charger_3_phase', max: 7360 });
    expect(selector().value).toBe('manual');
    expect(document.getElementById('device-detail-power-control-range')?.hidden).toBe(true);
  });

  it('offers the same Automatic model for an integration-derived Easee amp ladder', async () => {
    const device = {
      ...charger('automatic'), name: 'Easee', capabilities: ['target_charger_current'],
      automaticPowerControl: { mode: 'automatic' as const, profile: { steps: [
        { id: 'off', planningPowerW: 0, planningCurrentA: 0 },
        { id: '6a', planningPowerW: 1380, planningCurrentA: 6 },
        { id: '16a', planningPowerW: 3680, planningCurrentA: 16 },
      ] } },
    };
    const { subject } = await load(device);
    expect(document.getElementById('device-detail-power-control-row')?.hidden).toBe(false);
    expect(selector().value).toBe('automatic');
    expect(document.getElementById('device-detail-power-control-hint')?.textContent)
      .toContain('PELS determines the power levels from your charger’s settings.');
    expect(document.getElementById('device-detail-power-control-range')?.textContent)
      .toBe('Charging range: 1.38–3.68 kW');
    expect(subject.automaticPowerControlConsequences(device))
      .not.toContain('Your manual charging-current setup will not be used.');
  });

  it('does not reuse a previous confirmation when a later review is dismissed', async () => {
    const { refresh } = await load();
    choose('automatic');
    closeReview('confirm');
    await vi.waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
    choose('manual');
    await vi.waitFor(() => expect(refresh).toHaveBeenCalledTimes(2));
    choose('automatic');
    expect(dialog().returnValue).toBe('');
    closeReview();
    await Promise.resolve();
    expect(setSetting).toHaveBeenCalledTimes(2);
    expect(selector().value).toBe('manual');
  });

  it('waits for saved mode preferences and hides the selector for amp-only chargers', async () => {
    const { state, subject, device } = await load();
    state.devicePowerControlModesLoaded = false;
    subject.renderAutomaticPowerControl(device);
    expect(selector().disabled).toBe(true);
    choose('automatic');
    expect(dialog().open).toBe(false);
    expect(setSetting).not.toHaveBeenCalled();
    subject.renderAutomaticPowerControl({ ...device, automaticPowerControl: undefined });
    expect(document.getElementById('device-detail-power-control-row')?.hidden).toBe(true);
  });

  it.each([
    { name: 'legacy current-only Zaptec', capabilities: ['available_installation_current'] },
    { name: 'Zaptec without a usable watt ladder', capabilities: ['available_installation_current', 'target_power'] },
  ])('does not offer Automatic for $name, even with a saved Automatic preference', async ({ capabilities }) => {
    const { state, subject, device } = await load();
    const unsupported = {
      ...device, name: 'Zaptec Go', capabilities, automaticPowerControl: undefined,
      // A saved/manual stepped profile alone does not grant native support.
      steppedLoadProfile: profile,
    };
    state.latestDevices = [unsupported];
    state.devicePowerControlModes = { [device.id]: 'automatic' };
    subject.renderAutomaticPowerControl(unsupported);

    expect(document.getElementById('device-detail-power-control-row')?.hidden).toBe(true);
    choose('automatic');
    expect(dialog().open).toBe(false);
    expect(setSetting).not.toHaveBeenCalled();
  });
});
