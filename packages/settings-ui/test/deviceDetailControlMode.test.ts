import type { TargetDeviceSnapshot } from '../../contracts/src/types';

const buildDevice = (
  overrides: Partial<TargetDeviceSnapshot> = {},
): TargetDeviceSnapshot => ({
  id: 'device-1',
  name: 'Device',
  targets: [],
  currentOn: true,
  capabilities: ['measure_power', 'onoff'],
  ...overrides,
});

const optionValues = (
  options: Array<{ value: string }>,
): string[] => options.map((option) => option.value);

describe('device detail control mode options', () => {
  beforeEach(async () => {
    vi.resetModules();
    const { state } = await import('../src/ui/state.ts');
    state.deviceTargetPowerConfigs = {};
    state.deviceControlProfiles = {};
  });

  it('does not offer EV target-power presets for non-EV devices', async () => {
    const { getDeviceDetailControlModeOptions, isControlModeAllowedForDevice } = await import(
      '../src/ui/deviceDetail/controlMode.ts'
    );
    const device = buildDevice({ deviceClass: 'socket', deviceType: 'onoff' });

    expect(optionValues(getDeviceDetailControlModeOptions(device))).toEqual([
      'default',
      'stepped_load',
      'continuous',
    ]);
    expect(isControlModeAllowedForDevice('ev_charger_1_phase', device)).toBe(false);
    expect(isControlModeAllowedForDevice('ev_charger_3_phase', device)).toBe(false);
    expect(isControlModeAllowedForDevice('continuous', device)).toBe(true);
  });

  it('offers EV target-power presets for EV chargers', async () => {
    const { getDeviceDetailControlModeOptions, isControlModeAllowedForDevice } = await import(
      '../src/ui/deviceDetail/controlMode.ts'
    );
    const device = buildDevice({ deviceClass: 'evcharger', deviceType: 'onoff' });

    expect(optionValues(getDeviceDetailControlModeOptions(device))).toContain('ev_charger_1_phase');
    expect(optionValues(getDeviceDetailControlModeOptions(device))).toContain('ev_charger_3_phase');
    expect(isControlModeAllowedForDevice('ev_charger_1_phase', device)).toBe(true);
    expect(isControlModeAllowedForDevice('ev_charger_3_phase', device)).toBe(true);
  });

  it('preserves existing EV target-power presets on non-EV devices', async () => {
    const { state } = await import('../src/ui/state.ts');
    const {
      getDeviceDetailControlModeOptions,
      isControlModeAllowedForDevice,
      resolveDeviceDetailControlMode,
    } = await import('../src/ui/deviceDetail/controlMode.ts');
    const device = buildDevice({ deviceClass: 'socket', deviceType: 'onoff' });
    state.deviceTargetPowerConfigs = {
      [device.id]: {
        enabled: true,
        preset: 'ev_charger_1_phase',
        min: 0,
        max: 7360,
        step: 460,
      },
    };

    expect(resolveDeviceDetailControlMode(device)).toBe('ev_charger_1_phase');
    expect(optionValues(getDeviceDetailControlModeOptions(device))).toContain('ev_charger_1_phase');
    expect(optionValues(getDeviceDetailControlModeOptions(device))).toContain('ev_charger_3_phase');
    expect(isControlModeAllowedForDevice('ev_charger_1_phase', device)).toBe(true);
  });

  it('does not preserve disabled EV target-power presets on non-EV devices', async () => {
    const { state } = await import('../src/ui/state.ts');
    const {
      getDeviceDetailControlModeOptions,
      isControlModeAllowedForDevice,
      resolveDeviceDetailControlMode,
    } = await import('../src/ui/deviceDetail/controlMode.ts');
    const device = buildDevice({ deviceClass: 'socket', deviceType: 'onoff' });
    state.deviceTargetPowerConfigs = {
      [device.id]: {
        enabled: false,
        preset: 'ev_charger_1_phase',
        min: 0,
        max: 7360,
        step: 460,
      },
    };

    const options = optionValues(getDeviceDetailControlModeOptions(device));
    const resolvedMode = resolveDeviceDetailControlMode(device);
    expect(options).toEqual([
      'default',
      'stepped_load',
      'continuous',
    ]);
    expect(resolvedMode).toBe('default');
    expect(options).toContain(resolvedMode);
    expect(isControlModeAllowedForDevice('ev_charger_1_phase', device)).toBe(false);
    expect(isControlModeAllowedForDevice('ev_charger_3_phase', device)).toBe(false);
  });

  it('keeps native EV wiring locked to default and EV presets', async () => {
    const { getDeviceDetailControlModeOptions, isControlModeAllowedForDevice } = await import(
      '../src/ui/deviceDetail/controlMode.ts'
    );
    const device = buildDevice({
      deviceClass: 'evcharger',
      deviceType: 'onoff',
      controlAdapter: {
        kind: 'capability_adapter',
        activationRequired: true,
        activationEnabled: true,
      },
      controlWriteCapabilityId: 'charging_button',
    });

    expect(optionValues(getDeviceDetailControlModeOptions(device))).toEqual([
      'default',
      'ev_charger_1_phase',
      'ev_charger_3_phase',
    ]);
    expect(isControlModeAllowedForDevice('stepped_load', device)).toBe(false);
    expect(isControlModeAllowedForDevice('continuous', device)).toBe(false);
    expect(isControlModeAllowedForDevice('ev_charger_1_phase', device)).toBe(true);
  });
});
