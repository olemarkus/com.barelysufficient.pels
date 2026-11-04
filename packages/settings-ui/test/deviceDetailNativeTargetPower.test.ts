import type { SettingsUiDeviceSnapshot } from '../../contracts/src/settingsUi/devices';
import type { TargetPowerSteppedLoadConfig } from '../../contracts/src/types';
import { withDescriptorIdentity } from './helpers/deviceSnapshotFixture.ts';
import { createHomeyMock } from './helpers/homeyApiMock.ts';
import { mockDeviceDetailCollaborators } from './helpers/deviceDetailCollaborators.ts';

vi.mock('../src/ui/deviceDetail/chargingCurrent.tsx', () => ({ setChargingCurrentDevice: vi.fn() }));

const nativeProfile = {
  steps: [
    { id: 'off', planningPowerW: 0 },
    { id: '2530w', planningPowerW: 2530 },
    { id: '12650w', planningPowerW: 12650 },
  ],
};

const nativeDevice = (overrides: Partial<SettingsUiDeviceSnapshot> = {}): SettingsUiDeviceSnapshot => (
  withDescriptorIdentity<SettingsUiDeviceSnapshot>({
    id: 'charger', name: 'Charger', available: true,
    expectedPowerKw: 12.65, expectedPowerSource: 'default', targets: [],
    powerCapable: true, binaryControllable: true,
    deviceClass: 'evcharger', deviceType: 'onoff',
    binaryControl: { on: true }, capabilities: ['measure_power', 'evcharger_charging'],
    controlModel: 'stepped_load', steppedLoadProfile: nativeProfile,
    automaticPowerControl: { mode: 'automatic', profile: nativeProfile },
    suggestedSteppedLoadProfile: nativeProfile, nativeWriteCapabilities: ['target_power'],
    controlAdapter: { kind: 'capability_adapter', activationEnabled: true, activationRequired: false },
    ...overrides,
  })
);

const installPowerLevelEditor = (): void => {
  document.body.insertAdjacentHTML('beforeend', `
    <section id="device-detail-stepped-section"><details>
      <summary id="device-detail-stepped-hint"></summary>
      <p id="device-detail-stepped-intro"></p>
      <p id="device-detail-stepped-locked-note" hidden></p>
      <div id="device-detail-stepped-header"></div>
      <div id="device-detail-stepped-steps"></div>
      <p id="device-detail-stepped-climb-note"></p>
      <md-text-button id="device-detail-stepped-add-step"></md-text-button>
      <md-text-button id="device-detail-stepped-reset"></md-text-button>
      <md-filled-button id="device-detail-stepped-save"></md-filled-button>
    </details></section>
  `);
};

const manualPowerLevelRows = (): Array<[string, string]> => (
  [...document.querySelectorAll<HTMLElement>('[data-step-row="true"]')].map((row) => [
    row.querySelector<HTMLElement & { value: string }>('[data-step-field="id"]')!.value,
    row.querySelector<HTMLElement & { value: string }>('[data-step-field="planningPowerW"]')!.value,
  ])
);

describe('native target-power device setup', () => {
  beforeEach(async () => {
    vi.resetModules();
    document.body.innerHTML = `
      <div id="device-detail-target-power-config"></div>
      <div id="device-detail-target-power-fields"></div>
    `;
    const { state } = await import('../src/ui/state.ts');
    state.deviceTargetPowerConfigs = {};
    state.deviceControlProfiles = {};
    state.devicePowerControlModes = {};
    state.devicePowerControlModesLoaded = true;
  });

  it.each([
    { enabled: true, preset: 'ev_charger_3_phase', max: 22080 },
    { enabled: true, min: 0, max: 22080, step: 230 },
    { enabled: false },
  ] satisfies TargetPowerSteppedLoadConfig[])(
    'shows an active Automatic mode while retaining saved manual configuration %j',
    async (saved) => {
      const { state } = await import('../src/ui/state.ts');
      const { resolveDeviceDetailControlMode, hasEvTargetPowerPreset } = await import('../src/ui/deviceKind.ts');
      const { createDefaultSteppedLoadProfile } = await import('../src/ui/deviceControlProfiles.ts');
      const { getDeviceDetailControlModeOptions, isControlModeAllowedForDevice } = await import(
        '../src/ui/deviceDetail/controlMode.ts'
      );
      const { renderTargetPowerConfig } = await import('../src/ui/deviceDetail/targetPowerConfig.ts');
      const device = nativeDevice();
      state.deviceTargetPowerConfigs = { [device.id]: saved };

      expect(resolveDeviceDetailControlMode(device)).toBe('stepped_load');
      expect(hasEvTargetPowerPreset(device)).toBe(false);
      expect(getDeviceDetailControlModeOptions(device)).toEqual([{ value: 'stepped_load', label: 'Stepped load' }]);
      expect(isControlModeAllowedForDevice('ev_charger_3_phase', device)).toBe(false);
      expect(isControlModeAllowedForDevice('continuous', device)).toBe(false);
      expect(isControlModeAllowedForDevice('default', device)).toBe(false);
      expect(createDefaultSteppedLoadProfile(device)).toEqual(nativeProfile);
      renderTargetPowerConfig(device);
      expect(document.getElementById('device-detail-target-power-config')?.hidden).toBe(true);
      expect(document.getElementById('device-detail-target-power-fields')?.hidden).toBe(true);
      expect(state.deviceTargetPowerConfigs[device.id]).toEqual(saved);
    },
  );

  it('keeps a legacy manual phase setup editable when Automatic becomes available', async () => {
    const { state } = await import('../src/ui/state.ts');
    const { resolveDeviceDetailControlMode, hasEvTargetPowerPreset } = await import('../src/ui/deviceKind.ts');
    const { getDeviceDetailControlModeOptions, isControlModeAllowedForDevice } = await import(
      '../src/ui/deviceDetail/controlMode.ts'
    );
    const { isAutomaticPowerControlActive, isNativeSteppedLoadProfileActive } = await import(
      '../src/ui/deviceControlProfiles.ts'
    );
    const saved = { enabled: true, preset: 'ev_charger_3_phase' as const, max: 11040 };
    const device = nativeDevice({
      automaticPowerControl: { mode: 'manual', profile: nativeProfile },
      targetPowerConfig: saved,
      suggestedSteppedLoadProfile: undefined,
      nativeWriteCapabilities: undefined,
    });
    state.deviceTargetPowerConfigs = { [device.id]: saved };

    expect(isAutomaticPowerControlActive(device)).toBe(false);
    expect(isNativeSteppedLoadProfileActive(device)).toBe(false);
    expect(resolveDeviceDetailControlMode(device)).toBe('ev_charger_3_phase');
    expect(hasEvTargetPowerPreset(device)).toBe(true);
    expect(getDeviceDetailControlModeOptions(device).map((option) => option.value)).toContain('continuous');
    expect(isControlModeAllowedForDevice('ev_charger_3_phase', device)).toBe(true);
    expect(state.devicePowerControlModes).toEqual({});
  });

  it('honours an explicit Manual choice before the runtime descriptor refreshes', async () => {
    const { state } = await import('../src/ui/state.ts');
    const { isAutomaticPowerControlActive, isNativeSteppedLoadProfileActive } = await import(
      '../src/ui/deviceControlProfiles.ts'
    );
    const { resolveDeviceDetailControlMode } = await import('../src/ui/deviceKind.ts');
    const device = nativeDevice();
    state.devicePowerControlModes = { [device.id]: 'manual' };
    state.deviceTargetPowerConfigs = { [device.id]: { enabled: true, preset: 'ev_charger_3_phase' } };

    expect(isAutomaticPowerControlActive(device)).toBe(false);
    expect(isNativeSteppedLoadProfileActive(device)).toBe(false);
    expect(resolveDeviceDetailControlMode(device)).toBe('ev_charger_3_phase');
  });

  it('preserves an edited Manual profile across an Automatic visit', async () => {
    installPowerLevelEditor();
    const { state } = await import('../src/ui/state.ts');
    const { renderSteppedLoadDraft } = await import('../src/ui/deviceDetail/steppedLoadDraft.ts');
    const manualProfile = { steps: [
      { id: 'off', planningPowerW: 0 },
      { id: 'gentle', planningPowerW: 1800 },
      { id: 'fast', planningPowerW: 5400 },
    ] };
    const device = nativeDevice({
      automaticPowerControl: { mode: 'manual', profile: nativeProfile },
      steppedLoadProfile: manualProfile,
      suggestedSteppedLoadProfile: undefined,
      nativeWriteCapabilities: undefined,
    });
    state.deviceControlProfiles = { [device.id]: manualProfile };
    renderSteppedLoadDraft(device);
    expect(manualPowerLevelRows()).toEqual([['off', '0'], ['gentle', '1800'], ['fast', '5400']]);
    const gentlePower = document.querySelectorAll<HTMLElement & { value: string }>(
      '[data-step-field="planningPowerW"]',
    )[1];
    gentlePower.value = '2000';
    gentlePower.dispatchEvent(new Event('input'));

    // The saved preference reaches the UI before the runtime descriptor changes.
    state.devicePowerControlModes = { [device.id]: 'automatic' };
    renderSteppedLoadDraft(device);
    expect(document.querySelectorAll('[data-step-field]')).toHaveLength(0);
    expect([...document.querySelectorAll('#device-detail-stepped-steps > div')].map((row) => row.textContent))
      .toEqual(['Off', '2530 W', '12650 W']);

    state.devicePowerControlModes = { [device.id]: 'manual' };
    renderSteppedLoadDraft(device);
    expect(manualPowerLevelRows()).toEqual([['off', '0'], ['gentle', '2000'], ['fast', '5400']]);
    expect((document.getElementById('device-detail-stepped-save') as HTMLElement & { disabled: boolean }).disabled)
      .toBe(false);
    expect(state.deviceControlProfiles[device.id]).toEqual(manualProfile);
    expect(manualProfile.steps[1].planningPowerW).toBe(1800);
  });

  it('shows the app levels when Automatic opens before any Manual editor visit', async () => {
    installPowerLevelEditor();
    const { state } = await import('../src/ui/state.ts');
    const { renderSteppedLoadDraft } = await import('../src/ui/deviceDetail/steppedLoadDraft.ts');
    const manualProfile = { steps: [
      { id: 'off', planningPowerW: 0 }, { id: 'custom', planningPowerW: 4200 },
    ] };
    const device = nativeDevice();
    state.deviceControlProfiles = { [device.id]: manualProfile };
    renderSteppedLoadDraft(device);
    expect([...document.querySelectorAll('#device-detail-stepped-steps > div')].map((row) => row.textContent))
      .toEqual(['Off', '2530 W', '12650 W']);

    state.devicePowerControlModes = { [device.id]: 'manual' };
    renderSteppedLoadDraft(device);
    expect(manualPowerLevelRows()).toEqual([['off', '0'], ['custom', '4200']]);
  });

  it('keeps the selected phase preset available for an amp-controlled charger', async () => {
    const { state } = await import('../src/ui/state.ts');
    const { resolveDeviceDetailControlMode } = await import('../src/ui/deviceKind.ts');
    const { getDeviceDetailControlModeOptions } = await import('../src/ui/deviceDetail/controlMode.ts');
    const device = nativeDevice({
      nativeWriteCapabilities: ['target_charger_current'],
      automaticPowerControl: undefined,
      targetPowerConfig: { enabled: true, preset: 'ev_charger_3_phase' },
      suggestedSteppedLoadProfile: undefined,
    });
    state.deviceTargetPowerConfigs = { [device.id]: { enabled: true, preset: 'ev_charger_3_phase' } };

    expect(resolveDeviceDetailControlMode(device)).toBe('ev_charger_3_phase');
    expect(getDeviceDetailControlModeOptions(device).map((option) => option.value)).toContain('ev_charger_3_phase');
  });

  it('clears charging-current setup when the native watt ladder takes control', async () => {
    const { setChargingCurrentDevice } = await import('../src/ui/deviceDetail/chargingCurrent.tsx');
    const { setDeviceDetailNativeWiringState } = await import('../src/ui/deviceDetail/nativeWiring.ts');
    const device = nativeDevice({ automaticPowerControl: { mode: 'manual', profile: nativeProfile } });
    setDeviceDetailNativeWiringState(device);
    expect(setChargingCurrentDevice).toHaveBeenLastCalledWith(device.id);

    setDeviceDetailNativeWiringState(nativeDevice());
    expect(setChargingCurrentDevice).toHaveBeenLastCalledWith('');
  });

  it.each(['manual', 'automatic'] as const)('shows the Manual model row only while %s controls the charger', async (mode) => {
    document.body.insertAdjacentHTML('beforeend', `
      <div id="device-detail-overlay" hidden><div id="device-detail-panel">
        <h2 id="device-detail-title"></h2>
        <div id="device-detail-power-control-row" hidden>
          <md-filled-select id="device-detail-power-control-mode"></md-filled-select>
          <small id="device-detail-power-control-hint"></small>
          <small id="device-detail-power-control-range"></small>
        </div>
        <div id="device-detail-control-model-row">
          <md-filled-select id="device-detail-control-model">
            <md-select-option value="ev_charger_3_phase"></md-select-option>
            <md-select-option value="stepped_load"></md-select-option>
          </md-filled-select>
        </div>
      </div></div>
    `);
    mockDeviceDetailCollaborators();
    const homey = await import('../src/ui/homey.ts');
    homey.setHomeyClient(createHomeyMock({ settings: { managed_devices: { charger: true } } }));
    const { state } = await import('../src/ui/state.ts');
    const device = nativeDevice({
      automaticPowerControl: { mode, profile: nativeProfile },
      targetPowerConfig: mode === 'manual' ? { enabled: true, preset: 'ev_charger_3_phase' } : undefined,
      suggestedSteppedLoadProfile: mode === 'automatic' ? nativeProfile : undefined,
    });
    state.latestDevices = [device];
    state.managedMap = { [device.id]: true };
    state.deviceTargetPowerConfigs = { [device.id]: { enabled: true, preset: 'ev_charger_3_phase' } };
    const { openDeviceDetail } = await import('../src/ui/deviceDetail/index.ts');
    openDeviceDetail(device.id);

    expect(document.getElementById('device-detail-power-control-row')?.hidden).toBe(false);
    expect((document.getElementById('device-detail-power-control-mode') as HTMLElement & { value: string }).value)
      .toBe(mode);
    expect(document.getElementById('device-detail-control-model-row')?.hidden).toBe(mode === 'automatic');
    if (mode === 'manual') {
      expect((document.getElementById('device-detail-control-model') as HTMLElement & { disabled: boolean }).disabled)
        .toBe(false);
    }
  });
});
