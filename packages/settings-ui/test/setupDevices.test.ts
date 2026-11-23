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
  it('offers Managed for an unconfigured plug and names its Homey Energy setup', async () => {
    const { readSetupDeviceChoices } = await load();
    const choices = readSetupDeviceChoices([
      device('plug', 'Utility plug', { deviceClass: 'socket', powerCapable: false, capabilities: ['onoff'] }),
    ]);
    if (choices.state !== 'ready') throw new Error('Choices unavailable');
    expect(choices.devices).toHaveLength(1);
    expect(choices.devices[0]).toMatchObject({ id: 'plug', disabled: false });
    expect(choices.devices[0].hint).toContain('Advanced settings in Homey');
    expect(choices.devices[0].hint).not.toContain('temperature');
  });

  it('describes active and dormant last-resort devices without recommending Homey Energy', async () => {
    const { readSetupDeviceChoices } = await load();
    const { acceptDevicePowerSetup } = await import('../src/ui/devicePowerSetup.ts');
    const configuration = {
      name: 'Relay', configured: true, sourceId: null, sourceReady: false, usedBy: null, sources: [],
      lastResortMaximumW: 4500, lastResortAvailable: true, defaultBinarySwitchAvailable: true,
    };
    acceptDevicePowerSetup({ devices: [
      { ...configuration, id: 'active' },
      { ...configuration, id: 'dormant', binarySwitchId: 'onoff.unavailable' },
    ] });
    const relay = { powerCapable: false, capabilities: ['onoff'] };
    const choices = readSetupDeviceChoices([device('active', 'Active relay', relay), device('dormant', 'Dormant relay', relay)]);
    if (choices.state !== 'ready') throw new Error('Choices unavailable');
    expect(choices.devices.map(({ hint }) => hint)).toEqual([
      'Last resort. PELS can turn it off after limiting other devices.',
      'Review last-resort control in Device setup.',
    ]);
    expect(choices.devices.every(({ disabled }) => !disabled)).toBe(true);
  });

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
      device('a', 'Alpha', { zoneName: 'Living room', measuredPowerKw: 0 }),
      // Before the zone tree holds the zone, the row names no zone rather than its id.
      device('b', 'Beta', { expectedPowerKw: 2 }),
    ]);
    if (choices.state !== 'ready') throw new Error('Choices unavailable');
    expect(choices.devices.map(({ detail }) => detail)).toEqual(['Heater · Living room · 0 kW', 'Heater']);
  });
});
