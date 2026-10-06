import { withDescriptorIdentity } from './helpers/deviceSnapshotFixture.ts';
import type { TargetDeviceSnapshot } from '../../contracts/src/types';

const buildDevice = (
  overrides: Partial<TargetDeviceSnapshot> = {},
): TargetDeviceSnapshot => (withDescriptorIdentity<TargetDeviceSnapshot>({ available: true, expectedPowerKw: 1, expectedPowerSource: 'default',
  id: 'device-1',
  name: 'Device',
  targets: [],
  binaryControl: { on: true },
  capabilities: ['measure_power', 'onoff'],
  ...overrides,
}));

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
      isEvCharger: true,
    });
    expect(resolveDeviceDetailKind(device)).toBe('ev_charger');
  });

  it('resolves an EV charger from the charging control capability', async () => {
    const { resolveDeviceDetailKind } = await import('../src/ui/deviceKind.ts');
    const device = buildDevice({
      deviceClass: 'socket',
      deviceType: 'onoff',
      binaryControllable: true,
      isEvCharger: true,
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

describe('home battery in the settings UI', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('resolves a home battery as its own device page kind', async () => {
    const { resolveDeviceDetailKind } = await import('../src/ui/deviceKind.ts');
    expect(resolveDeviceDetailKind(buildDevice({ deviceClass: 'battery', isBatteryOrSolar: true })))
      .toBe('battery');
  });

  it('reads a battery\'s Managed from its own setting: on unless turned off', async () => {
    const { state, resolveManagedState } = await import('../src/ui/state.ts');
    state.latestDevices = [buildDevice({ id: 'battery-1', deviceClass: 'battery', isBatteryOrSolar: true })];
    state.managedMap = {};
    state.batteryControl = { status: 'resolved', devices: {} };
    expect(resolveManagedState('battery-1')).toBe(true);
    state.batteryControl = { status: 'resolved', devices: { 'battery-1': false } };
    expect(resolveManagedState('battery-1')).toBe(false);
    // `managed_devices` has no say over a battery.
    state.managedMap = { 'battery-1': true };
    expect(resolveManagedState('battery-1')).toBe(false);
  });

  it('shows a battery unmanaged and its switch unavailable while the stored map does not parse', async () => {
    const { state, resolveManagedState } = await import('../src/ui/state.ts');
    const { applyBatteryControlSettings } = await import('../src/ui/modeSettingsRead.ts');
    const { resolveDeviceManageability } = await import('../src/ui/deviceListPresentation.ts');
    const battery = buildDevice({ id: 'battery-1', deviceClass: 'battery', isBatteryOrSolar: true });
    state.latestDevices = [battery];
    applyBatteryControlSettings({ batteryControl: { 'battery-1': 'yes' } } as never);

    expect(state.batteryControl).toEqual({ status: 'unreadable' });
    expect(resolveManagedState('battery-1')).toBe(false);
    expect(resolveDeviceManageability(battery)).toMatchObject({ canManage: false, isManaged: false });

    applyBatteryControlSettings({ batteryControl: null } as never);
    expect(resolveManagedState('battery-1')).toBe(true);
  });

  it('claims whole-house cover only for a battery last in the list', async () => {
    const { resolveBatteryPriorityHint } = await import('../src/ui/deviceDetail/batterySection.ts');
    expect(resolveBatteryPriorityHint({ rank: 5, total: 5 }))
      .toBe('Last in the list, it covers the whole house before any device is limited.');
    expect(resolveBatteryPriorityHint({ rank: 3, total: 5 }))
      .toBe('Its place decides who it protects: the devices above it.');
  });
});
