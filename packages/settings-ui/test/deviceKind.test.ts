import type { TargetDeviceSnapshot } from '../../contracts/src/types';

const buildDevice = (
  overrides: Partial<TargetDeviceSnapshot> = {},
): TargetDeviceSnapshot => ({ expectedPowerKw: 1, expectedPowerSource: 'default',
  id: 'device-1',
  name: 'Device',
  targets: [],
  binaryControl: { on: true },
  capabilities: ['measure_power', 'onoff'],
  ...overrides,
});

describe('resolveDeviceDetailKind', () => {
  beforeEach(async () => {
    vi.resetModules();
    const { state } = await import('../src/ui/state.ts');
    state.deviceTargetPowerConfigs = {};
    state.deviceControlProfiles = {};
  });

  it('resolves an EV charger by device class', async () => {
    const { resolveDeviceDetailKind } = await import('../src/ui/deviceKind.ts');
    expect(resolveDeviceDetailKind(buildDevice({ deviceClass: 'evcharger', deviceType: 'onoff' })))
      .toBe('ev_charger');
  });

  it('resolves an EV charger from a stored EV preset alone', async () => {
    const { state } = await import('../src/ui/state.ts');
    const { resolveDeviceDetailKind } = await import('../src/ui/deviceKind.ts');
    const device = buildDevice({ deviceClass: 'socket', deviceType: 'onoff' });
    state.deviceTargetPowerConfigs = {
      [device.id]: { enabled: true, preset: 'ev_charger_1_phase', min: 0, max: 7360, step: 460 },
    };
    expect(resolveDeviceDetailKind(device)).toBe('ev_charger');
  });

  it('resolves an EV charger from active native EV wiring', async () => {
    const { resolveDeviceDetailKind } = await import('../src/ui/deviceKind.ts');
    const device = buildDevice({
      deviceClass: 'socket',
      deviceType: 'onoff',
      controlAdapter: { kind: 'capability_adapter', activationRequired: false, activationEnabled: true },
      controlWriteCapabilityId: 'charging_button',
    });
    expect(resolveDeviceDetailKind(device)).toBe('ev_charger');
  });

  it('resolves an EV charger from the charging control capability', async () => {
    const { resolveDeviceDetailKind } = await import('../src/ui/deviceKind.ts');
    const device = buildDevice({
      deviceClass: 'socket',
      deviceType: 'onoff',
      controlCapabilityId: 'evcharger_charging',
    });
    expect(resolveDeviceDetailKind(device)).toBe('ev_charger');
  });

  it('does not resolve EV from a disabled preset; falls through on capability', async () => {
    const { state } = await import('../src/ui/state.ts');
    const { resolveDeviceDetailKind } = await import('../src/ui/deviceKind.ts');
    const device = buildDevice({ deviceClass: 'socket', deviceType: 'onoff' });
    state.deviceTargetPowerConfigs = {
      [device.id]: { enabled: false, preset: 'ev_charger_1_phase' },
    };
    expect(resolveDeviceDetailKind(device)).toBe('binary');
  });

  it('resolves a thermostat as temperature', async () => {
    const { resolveDeviceDetailKind } = await import('../src/ui/deviceKind.ts');
    const device = buildDevice({
      deviceClass: 'thermostat',
      deviceType: 'temperature',
      targets: [{ id: 'target_temperature', value: 21, unit: '\u00b0C' }],
    });
    expect(resolveDeviceDetailKind(device)).toBe('temperature');
  });

  it('keeps a thermostat with a stepped control model as temperature', async () => {
    const { state } = await import('../src/ui/state.ts');
    const { resolveDeviceDetailKind, isSteppedLoadControlModel } = await import('../src/ui/deviceKind.ts');
    const device = buildDevice({
      deviceClass: 'thermostat',
      deviceType: 'temperature',
      targets: [{ id: 'target_temperature', value: 65, unit: '\u00b0C' }],
    });
    state.deviceControlProfiles = {
      [device.id]: {
        steps: [{ id: 'off', planningPowerW: 0 }, { id: 'max', planningPowerW: 2000 }],
      },
    };
    expect(isSteppedLoadControlModel(device)).toBe(true);
    expect(resolveDeviceDetailKind(device)).toBe('temperature');
  });

  it('resolves a non-temperature stepped device as stepped', async () => {
    const { state } = await import('../src/ui/state.ts');
    const { resolveDeviceDetailKind } = await import('../src/ui/deviceKind.ts');
    const device = buildDevice({ deviceClass: 'heater', deviceType: 'onoff' });
    state.deviceControlProfiles = {
      [device.id]: {
        steps: [{ id: 'off', planningPowerW: 0 }, { id: 'max', planningPowerW: 3000 }],
      },
    };
    expect(resolveDeviceDetailKind(device)).toBe('stepped');
  });

  it('resolves a plain socket as binary', async () => {
    const { resolveDeviceDetailKind } = await import('../src/ui/deviceKind.ts');
    expect(resolveDeviceDetailKind(buildDevice({ deviceClass: 'socket', deviceType: 'onoff' })))
      .toBe('binary');
  });

  it('resolves null and undefined as binary', async () => {
    const { resolveDeviceDetailKind } = await import('../src/ui/deviceKind.ts');
    expect(resolveDeviceDetailKind(null)).toBe('binary');
    expect(resolveDeviceDetailKind(undefined)).toBe('binary');
  });
});
