// The model reads `state`, the home roster and the setup facts, so each test
// loads fresh copies and publishes what it needs.
const load = async (membershipByDeviceId: Readonly<Record<string, string>> = {}) => {
  vi.resetModules();
  vi.doMock('../src/ui/homeScope.ts', () => ({
    readHomeMembership: () => ({ state: 'resolved', membershipByDeviceId }),
    subscribeToHomeScope: () => undefined,
  }));
  const goals = await import('../src/ui/setupGoals.ts');
  const facts = await import('../src/ui/setupPathFacts.ts');
  const { state } = await import('../src/ui/state.ts');
  state.devicesLoaded = true;
  respondToPrices(facts, true);
  return { goals, facts, state };
};

type Loaded = Awaited<ReturnType<typeof load>>;
type Device = Loaded['state']['latestDevices'][number];

const respondToPrices = (facts: Pick<Loaded['facts'], 'publishSetupPrices'>, respond: boolean) => facts.publishSetupPrices({
  respondToPrices: respond,
  budgetShapesByPrice: false,
  status: { state: 'complete', summary: 'Homey Energy' },
});

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

const manage = (state: Loaded['state'], devices: Device[]) => {
  state.latestDevices = devices;
  state.managedMap = Object.fromEntries(devices.map((device) => [device.id, true]));
  state.controllableMap = Object.fromEntries(devices.map((device) => [device.id, true]));
};

const ready = (read: ReturnType<Loaded['goals']['resolveSetupGoalChoices']>) => {
  if (read.state !== 'ready') throw new Error(`choices are ${read.state}`);
  return read.devices;
};

afterEach(() => {
  window.history.replaceState(null, '', '/');
});

describe('Choose what PELS does', () => {
  it('offers Price-based control for a heating device and a smart task for an EV charger', async () => {
    const { goals, state } = await load();
    manage(state, [heatPump, charger]);
    expect(ready(goals.resolveSetupGoalChoices())).toEqual([
      { id: 'pump', name: 'Heat pump', price: { enabled: false }, smartTask: null, solar: null },
      { id: 'charger', name: 'Easee', price: null, smartTask: { state: 'none' }, solar: null },
    ]);
    expect(goals.offersSetupGoals()).toBe(true);
  });

  it('shows the Price-based control the owner already saved', async () => {
    const { goals, state } = await load();
    manage(state, [heatPump]);
    state.priceOptimizationSettings = {
      pump: { enabled: true, cheapDelta: 5, expensiveDelta: -5, priceConfigured: true, surplusWilling: false, surplusDelta: 2 },
    };
    expect(ready(goals.resolveSetupGoalChoices())[0]?.price).toEqual({ enabled: true });
  });

  it('states the open smart task of a charger as the device page does', async () => {
    const { goals, state } = await load();
    manage(state, [charger]);
    state.deferredObjectiveSettings = { objectivesByDeviceId: { charger: {
      enabled: true, kind: 'ev_soc', enforcement: 'soft', targetPercent: 80, deadlineAtMs: Date.now() + 3_600_000,
    } } };
    const smartTask = ready(goals.resolveSetupGoalChoices())[0]?.smartTask;
    expect(smartTask?.state).toBe('open');
    expect(smartTask?.state === 'open' ? smartTask.summary : '').toMatch(/80/);
  });

  it('offers no Price-based control while PELS does not respond to prices', async () => {
    const { goals, facts, state } = await load();
    manage(state, [heatPump, charger]);
    respondToPrices(facts, false);
    expect(ready(goals.resolveSetupGoalChoices()))
      .toEqual([{ id: 'charger', name: 'Easee', price: null, smartTask: { state: 'none' }, solar: null }]);
  });

  it('leaves out devices PELS does not manage, devices in a meter area, and devices with nothing to choose', async () => {
    const { goals, state } = await load({ charger: 'garage' });
    manage(state, [heatPump, charger, socket]);
    state.managedMap.pump = false;
    expect(ready(goals.resolveSetupGoalChoices())).toEqual([]);
    expect(goals.offersSetupGoals()).toBe(false);
  });

  it('adds the solar action once surplus can reach it, except in the solar setup that offered it already', async () => {
    const { goals, state } = await load();
    manage(state, [socket]);
    expect(ready(goals.resolveSetupGoalChoices())).toEqual([]);
    state.surplusPoolReachable = true;
    expect(ready(goals.resolveSetupGoalChoices()).map((device) => device.solar?.label)).toEqual(['Run on solar surplus']);
    window.history.replaceState(null, '', '/?setup=solar&setupGoal=solar');
    expect(ready(goals.resolveSetupGoalChoices())).toEqual([]);
  });

  it('decides nothing while the device list is still loading', async () => {
    const { goals, state } = await load();
    state.devicesLoaded = false;
    expect(goals.resolveSetupGoalChoices()).toEqual({ state: 'loading' });
  });
});
