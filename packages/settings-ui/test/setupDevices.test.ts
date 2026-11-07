import type { SettingsUiDeviceListItem } from '../src/ui/deviceUtils.ts';

const load = async () => {
  vi.resetModules();
  vi.doMock('../src/ui/homeScope.ts', () => ({
    readHomeMembership: () => ({ state: 'resolved', membershipByDeviceId: {} }),
    subscribeToHomeScope: () => undefined,
  }));
  const { state } = await import('../src/ui/state.ts');
  state.devicesLoaded = true;
  state.initialLoadComplete = true;
  const { readSetupDeviceChoices } = await import('../src/ui/setupDevices.ts');
  return { state, readSetupDeviceChoices };
};

const device = (id: string, name: string, extra: Partial<SettingsUiDeviceListItem> = {}): SettingsUiDeviceListItem => ({
  id, name, available: true, targets: [], deviceClass: 'heater', deviceType: 'onoff', powerCapable: true,
  managed: false, isEvCharger: false, isBatteryOrSolar: false, expectedPowerKw: 1, expectedPowerSource: 'default',
  binaryControllable: true, batteryControl: 'not_battery', batteryTakenOver: false, batteryUsesHomeyApiKey: false,
  ...extra,
});

describe('Setup device choices', () => {
  it('keeps the same order when a newly managed device moves first in the API payload', async () => {
    const { state, readSetupDeviceChoices } = await load();
    const alpha = device('a', 'Alpha');
    const mill = device('m', 'Mill');
    const before = readSetupDeviceChoices([alpha, mill]);
    state.managedMap = { m: true };
    const after = readSetupDeviceChoices([mill, alpha]);
    expect(before.state).toBe('ready');
    expect(after.state).toBe('ready');
    if (before.state !== 'ready' || after.state !== 'ready') throw new Error('Choices unavailable');
    expect(before.devices.map(({ id }) => id)).toEqual(['a', 'm']);
    expect(after.devices.map(({ id }) => id)).toEqual(['a', 'm']);
    expect(after.devices[1]?.managed).toBe(true);
  });

  it('shows class, zone and zero observed power, without inventing absent readings', async () => {
    const { readSetupDeviceChoices } = await load();
    const choices = readSetupDeviceChoices([
      device('a', 'Alpha', { zone: 'Living room', measuredPowerKw: 0 }),
      device('b', 'Beta', { expectedPowerKw: 2 }),
    ]);
    if (choices.state !== 'ready') throw new Error('Choices unavailable');
    expect(choices.devices.map(({ detail }) => detail)).toEqual(['Heater · Living room · 0 kW', 'Heater']);
  });
});
