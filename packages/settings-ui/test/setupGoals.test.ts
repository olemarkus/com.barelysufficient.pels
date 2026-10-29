// The model reads `state` and the home roster, so each test loads fresh copies.
const load = async (membershipByDeviceId: Readonly<Record<string, string>> = {}) => {
  vi.resetModules();
  vi.doMock('../src/ui/homeScope.ts', () => ({
    readHomeMembership: () => ({ state: 'resolved', membershipByDeviceId }),
    subscribeToHomeScope: () => undefined,
  }));
  const goals = await import('../src/ui/setupGoals.ts');
  const { state } = await import('../src/ui/state.ts');
  state.devicesLoaded = true;
  return { goals, state };
};

type Loaded = Awaited<ReturnType<typeof load>>;
type Device = Loaded['state']['latestDevices'][number];

const heatPump = {
  id: 'pump', name: 'Heat pump', deviceType: 'temperature', targets: [{ id: 'target_temperature' }],
  isEvCharger: false, isBatteryOrSolar: false, powerCapable: true, capabilities: ['target_temperature', 'measure_power'],
} as unknown as Device;
const charger = {
  id: 'charger', name: 'Easee', deviceType: 'onoff', targets: [], deviceClass: 'evcharger',
  isEvCharger: true, isBatteryOrSolar: false, powerCapable: true, capabilities: ['onoff', 'measure_power'],
} as unknown as Device;
const socket = {
  id: 'socket', name: 'Pool pump', deviceType: 'onoff', targets: [], deviceClass: 'socket',
  isEvCharger: false, isBatteryOrSolar: false, powerCapable: true, binaryControllable: true,
  capabilities: ['onoff', 'measure_power'],
} as unknown as Device;

const NO_SOLAR = { respondsToPrices: true, priceSourceName: null, solarReady: false, solarJourney: false };

const manage = (state: Loaded['state'], devices: Device[]) => {
  state.latestDevices = devices;
  state.managedMap = Object.fromEntries(devices.map((device) => [device.id, true]));
  state.controllableMap = Object.fromEntries(devices.map((device) => [device.id, true]));
};

const ready = (read: ReturnType<Loaded['goals']['resolveSetupGoalChoices']>) => {
  if (read.state !== 'ready') throw new Error(`choices are ${read.state}`);
  return read.devices;
};

describe('Choose what PELS does', () => {
  it('offers Price-based control for a heating device and a smart task for an EV charger', async () => {
    const { goals, state } = await load();
    manage(state, [heatPump, charger]);
    expect(ready(goals.resolveSetupGoalChoices(state.latestDevices, NO_SOLAR))).toEqual([
      { id: 'pump', name: 'Heat pump', price: { enabled: false, source: null }, smartTask: null, solar: null },
      { id: 'charger', name: 'Easee', price: null, smartTask: 'none', solar: null },
    ]);
  });

  it('shows the Price-based control the owner already saved', async () => {
    const { goals, state } = await load();
    manage(state, [heatPump]);
    state.priceOptimizationSettings = {
      pump: { enabled: true, cheapDelta: 5, expensiveDelta: -5, priceConfigured: true, surplusWilling: false, surplusDelta: 2 },
    };
    expect(ready(goals.resolveSetupGoalChoices(state.latestDevices, NO_SOLAR))[0]?.price).toEqual({ enabled: true, source: null });
  });

  it('offers no Price-based control while PELS does not respond to prices', async () => {
    const { goals, state } = await load();
    manage(state, [heatPump, charger]);
    expect(ready(goals.resolveSetupGoalChoices(state.latestDevices, { ...NO_SOLAR, respondsToPrices: false })))
      .toEqual([{ id: 'charger', name: 'Easee', price: null, smartTask: 'none', solar: null }]);
  });

  it('leaves out devices PELS does not manage, devices in a meter area, and devices with nothing to choose', async () => {
    const { goals, state } = await load({ charger: 'garage' });
    manage(state, [heatPump, charger, socket]);
    state.managedMap.pump = false;
    expect(ready(goals.resolveSetupGoalChoices(state.latestDevices, NO_SOLAR))).toEqual([]);
  });

  it('adds the solar action once surplus can reach it, except in the solar setup that offered it already', async () => {
    const { goals, state } = await load();
    manage(state, [socket]);
    expect(ready(goals.resolveSetupGoalChoices(state.latestDevices, NO_SOLAR))).toEqual([]);
    const withSolar = ready(goals.resolveSetupGoalChoices(state.latestDevices, { ...NO_SOLAR, solarReady: true }));
    expect(withSolar.map((device) => device.solar?.label)).toEqual(['Run on solar surplus']);
    expect(ready(goals.resolveSetupGoalChoices(
      state.latestDevices, { ...NO_SOLAR, solarReady: true, solarJourney: true },
    ))).toEqual([]);
  });

  it('decides nothing while the device list or the roster is still loading', async () => {
    const { goals, state } = await load();
    state.devicesLoaded = false;
    expect(goals.resolveSetupGoalChoices([heatPump], NO_SOLAR)).toEqual({ state: 'loading' });
  });
});
