import type { ChargingCurrentRead } from '../../contracts/src/chargingControl.ts';

// The model reads `state`, the home roster and the setup facts, so each test
// loads fresh copies and publishes what it needs.
const savedPlans = vi.fn<() => Promise<Record<string, unknown>>>(async () => ({}));
const savePlan = vi.fn(async (_deviceId: string, config: unknown) => config);

const load = async (membershipByDeviceId: Readonly<Record<string, string>> = {}) => {
  vi.resetModules();
  vi.doMock('../src/ui/homeScope.ts', () => ({
    readHomeMembership: () => ({ state: 'resolved', membershipByDeviceId }),
    subscribeToHomeScope: () => undefined,
  }));
  vi.doMock('../src/ui/deviceDetail/continuousBatteryPlanTransport.ts', () => ({
    loadSavedContinuousBatteryPlanConfigs: () => savedPlans(),
    saveContinuousBatteryPlanConfig: (deviceId: string, config: unknown) => savePlan(deviceId, config),
    loadBatteryPlanPriceUnit: async () => 'EUR/kWh',
  }));
  const goals = await import('../src/ui/setupGoals.ts');
  const facts = await import('../src/ui/setupPathFacts.ts');
  const { state } = await import('../src/ui/state.ts');
  state.devicesLoaded = true;
  state.deferredObjectiveSettingsReadState = 'ready';
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

describe('Choose what PELS does', () => {
  it('offers Price-based control for a heating device and a smart task for an EV charger', async () => {
    const { goals, state } = await load();
    manage(state, [heatPump, charger]);
    expect(ready(goals.resolveSetupGoalChoices())).toEqual([
      {
        id: 'pump', name: 'Heat pump', price: { enabled: false }, smartTask: { state: 'none', charger: false }, solar: null,
        battery: null, noGoalReason: null,
      },
      { id: 'charger', name: 'Easee', price: null, smartTask: { state: 'none', charger: true }, solar: null,
        battery: null, noGoalReason: null },
    ]);
    expect(goals.resolveSetupGoalChoices()).toMatchObject({ hasActions: true });
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
      .toEqual([
        { id: 'pump', name: 'Heat pump', price: null, smartTask: { state: 'none', charger: false }, solar: null,
          battery: null, noGoalReason: null },
        { id: 'charger', name: 'Easee', price: null, smartTask: { state: 'none', charger: true }, solar: null,
          battery: null, noGoalReason: null },
      ]);
  });

  it('explains the managed unmetered relay and leaves out unmanaged and meter-area devices', async () => {
    const { goals, state } = await load({ charger: 'garage' });
    manage(state, [heatPump, charger, socket]);
    state.managedMap.pump = false;
    expect(goals.resolveSetupGoalChoices()).toMatchObject({
      hasActions: false,
      devices: [{ id: 'socket', price: null, smartTask: null, solar: null, battery: null, noGoalReason: 'needs_live_power' }],
    });
    state.managedMap.socket = false;
    expect(ready(goals.resolveSetupGoalChoices())).toEqual([]);
  });

  it('clears the relay explanation once it reports live measured power', async () => {
    const { goals, state } = await load();
    manage(state, [{ ...socket, measuredPowerKw: 0.4, measuredPowerIsDirectMeasurement: false }]);
    expect(ready(goals.resolveSetupGoalChoices())[0]?.noGoalReason).toBe('needs_live_power');
    manage(state, [{ ...socket, measuredPowerKw: 0.4, measuredPowerIsDirectMeasurement: true }]);
    expect(goals.resolveSetupGoalChoices()).toMatchObject({
      hasActions: true,
      devices: [{ id: 'socket', noGoalReason: null, smartTask: { state: 'none', charger: false } }],
    });
  });

  it('adds the solar action once surplus can reach it', async () => {
    const { goals, state } = await load();
    manage(state, [socket]);
    expect(ready(goals.resolveSetupGoalChoices())[0]?.solar).toBeNull();
    state.surplusPoolReachable = true;
    expect(ready(goals.resolveSetupGoalChoices()).map((device) => device.solar?.label)).toEqual(['Run on solar surplus']);
  });

  it('offers solar before any export when a managed battery PELS can drive is soaking the surplus', async () => {
    const { goals, state } = await load();
    const homeBattery = {
      id: 'battery', name: 'Thuisbatterij', deviceType: 'onoff', targets: [], deviceClass: 'battery',
      isEvCharger: false, isBatteryOrSolar: true, powerCapable: true, batteryControl: 'drivable',
      capabilities: ['measure_power', 'measure_battery'],
    } as unknown as Device;
    manage(state, [socket]);
    state.latestDevices = [socket, homeBattery];
    state.hasManagedSolarDevice = true;
    state.surplusPoolReachable = false;
    state.batteryControl = { status: 'resolved', devices: { battery: false } };
    expect(ready(goals.resolveSetupGoalChoices()).find((device) => device.id === 'socket')?.solar).toBeNull();
    state.batteryControl = { status: 'resolved', devices: { battery: true } };
    expect(ready(goals.resolveSetupGoalChoices()).find((device) => device.id === 'socket')?.solar?.label)
      .toBe('Run on solar surplus');
  });

  it('keeps the saved solar choice while directing a car to its missing consent', async () => {
    let carSetup: ChargingCurrentRead = {
      deviceId: 'charger', name: 'Family car', scope: 'vehicle',
      setup: { method: 'built_in', confirmation: 'none' }, supportsAppAction: true, capabilityWritable: false,
      sharedInstallation: false, flowCheck: 'clear', flowNames: [],
      currentRoute: 'built_in', missingCompanion: 'none',
    };
    vi.doMock('../src/ui/homey.ts', async (importOriginal) => ({
      ...await importOriginal<typeof import('../src/ui/homey.ts')>(),
      callApi: async (_method: string, path: string) => (path === '/ui_charging_current'
        ? [carSetup] : { configured: true, state: 'ready' }),
    }));
    try {
      const { goals, state } = await load();
      manage(state, [charger]);
      state.surplusPoolReachable = true;
      state.deviceTargetPowerConfigs = { charger: { enabled: true, preset: 'ev_charger_3_phase' } };
      state.priceOptimizationSettings = {
        charger: { enabled: false, cheapDelta: 0, expensiveDelta: 0,
          priceConfigured: false, surplusWilling: true, surplusDelta: 0 },
      };
      const charging = await import('../src/ui/chargingSetupFacts.ts');
      await charging.loadChargingSetup();
      expect(ready(goals.resolveSetupGoalChoices())[0]?.solar).toMatchObject({
        configured: true,
        hint: 'Turn on “Control charging through this car” in Setup.',
        actionLabel: 'Finish charging setup',
        focus: 'charging-control',
      });

      carSetup = { ...carSetup, setup: { ...carSetup.setup, confirmation: 'vehicle' } };
      await charging.loadChargingSetup();
      expect(ready(goals.resolveSetupGoalChoices())[0]?.solar).toMatchObject({
        configured: true, hint: null, actionLabel: 'Charge on solar surplus', focus: 'solar',
      });
      expect(state.priceOptimizationSettings.charger?.surplusWilling).toBe(true);
    } finally {
      vi.doUnmock('../src/ui/homey.ts');
    }
  });

  describe('a home battery', () => {
    const battery = {
      id: 'battery', name: 'Thuisbatterij', deviceType: 'onoff', targets: [], deviceClass: 'battery',
      isEvCharger: false, isBatteryOrSolar: true, powerCapable: true, batteryControl: 'drivable',
      capabilities: ['measure_power', 'measure_battery'],
    } as unknown as Device;
    const manageBattery = (state: Loaded['state'], device: Device = battery) => {
      state.latestDevices = [device];
      state.managedMap = {};
      state.controllableMap = {};
      state.batteryControl = { status: 'resolved', devices: {} };
    };
    const batteryGoal = (goals: Loaded['goals']) => ready(goals.resolveSetupGoalChoices())[0]?.battery;

    beforeEach(() => {
      savedPlans.mockReset().mockResolvedValue({});
      savePlan.mockClear();
    });

    it('is offered by its own Managed setting, and waits for the saved plans', async () => {
      const { goals, state } = await load();
      manageBattery(state);
      expect(batteryGoal(goals)).toEqual({ state: 'loading' });
      expect(goals.resolveSetupGoalChoices()).toMatchObject({ hasActions: false });
      const plans = await import('../src/ui/setupBatteryPlan.ts');
      await plans.loadSetupBatteryPlans();
      expect(goals.resolveSetupGoalChoices()).toMatchObject({ hasActions: true });
    });

    it('asks for a usable capacity a battery never saved, instead of assuming one', async () => {
      const { goals, state } = await load();
      manageBattery(state);
      const plans = await import('../src/ui/setupBatteryPlan.ts');
      await plans.loadSetupBatteryPlans();
      expect(batteryGoal(goals)).toEqual({
        state: 'ready', enabled: false, capacityKWh: null, simulating: state.dryRun, othersPlanned: false,
      });
    });

    it('fills in the capacity the owner saved, and whether the plan is on', async () => {
      const { DEFAULT_CONTINUOUS_BATTERY_PLAN_CONFIG } = await import('../../shared-domain/src/settings/continuousBatteryPlan.ts');
      savedPlans.mockResolvedValue({
        battery: { ...DEFAULT_CONTINUOUS_BATTERY_PLAN_CONFIG, enabled: true, usableCapacityKWh: 5.12, priceUnit: 'EUR/kWh' },
      });
      const { goals, state } = await load();
      manageBattery(state);
      const plans = await import('../src/ui/setupBatteryPlan.ts');
      await plans.loadSetupBatteryPlans();
      expect(batteryGoal(goals)).toMatchObject({ state: 'ready', enabled: true, capacityKWh: 5.12, othersPlanned: false });
      expect(plans.isSetupBatteryPlanOn('battery')).toBe(true);
      expect(plans.countSetupBatteryPlansOn()).toBe(1);
    });

    it('says when another battery also plans', async () => {
      const { DEFAULT_CONTINUOUS_BATTERY_PLAN_CONFIG } = await import('../../shared-domain/src/settings/continuousBatteryPlan.ts');
      const on = { ...DEFAULT_CONTINUOUS_BATTERY_PLAN_CONFIG, enabled: true, usableCapacityKWh: 5, priceUnit: 'EUR/kWh' };
      savedPlans.mockResolvedValue({ battery: on, other: on });
      const { goals, state } = await load();
      manageBattery(state);
      const plans = await import('../src/ui/setupBatteryPlan.ts');
      await plans.loadSetupBatteryPlans();
      expect(batteryGoal(goals)).toMatchObject({ state: 'ready', enabled: true, othersPlanned: true });
      expect(plans.countSetupBatteryPlansOn()).toBe(2);
    });

    it('publishes a loaded battery plan into the required Prices step', async () => {
      const { DEFAULT_CONTINUOUS_BATTERY_PLAN_CONFIG } = await import('../../shared-domain/src/settings/continuousBatteryPlan.ts');
      savedPlans.mockResolvedValue({ battery: { ...DEFAULT_CONTINUOUS_BATTERY_PLAN_CONFIG, enabled: true } });
      const { facts, state } = await load();
      manageBattery(state);
      facts.publishSetupPower({ state: 'received' });
      facts.publishSetupHardCapRead(true, {
        capacityEnabled: true, gridImportLimitKw: null, limitKw: 10, marginKw: 0.2,
        dryRun: true, periodMinutes: 60, followMonthPeak: false,
      });
      facts.publishSetupPrices({
        respondToPrices: true, budgetShapesByPrice: false,
        status: { state: 'open', summary: 'Choose your Norway price settings.' },
      });
      const plans = await import('../src/ui/setupBatteryPlan.ts');
      await plans.loadSetupBatteryPlans();
      expect(facts.readSetupReview()?.steps.find((step) => step.id === 'prices'))
        .toMatchObject({ status: 'next', detail: 'Choose your Norway price settings.' });
    });

    it('recovers the first battery read through the device-refresh retry', async () => {
      const { goals, state } = await load();
      manageBattery(state);
      const plans = await import('../src/ui/setupBatteryPlan.ts');
      savedPlans.mockRejectedValueOnce(new Error('temporarily unavailable'));
      await plans.loadSetupBatteryPlans();
      expect(batteryGoal(goals)).toEqual({ state: 'unavailable' });
      await plans.retrySetupBatteryPlans();
      expect(batteryGoal(goals)).toMatchObject({ state: 'ready', enabled: false });
      expect(savedPlans).toHaveBeenCalledTimes(2);
      await plans.retrySetupBatteryPlans();
      expect(savedPlans).toHaveBeenCalledTimes(2);
    });

    it('keeps an accepted enable when its follow-up read fails, including the required Prices step', async () => {
      const { goals, facts, state } = await load();
      manageBattery(state);
      facts.publishSetupPower({ state: 'received' });
      facts.publishSetupHardCapRead(true, {
        capacityEnabled: true, gridImportLimitKw: null, limitKw: 10, marginKw: 0.2,
        dryRun: true, periodMinutes: 60, followMonthPeak: false,
      });
      facts.publishSetupPrices({
        respondToPrices: true, budgetShapesByPrice: false,
        status: { state: 'open', summary: 'Choose your Norway price settings.' },
      });
      const plans = await import('../src/ui/setupBatteryPlan.ts');
      await plans.loadSetupBatteryPlans();
      savedPlans.mockRejectedValueOnce(new Error('read failed after accepted save'));
      await plans.saveSetupBatteryPlan('battery', true, 5.12);
      expect(batteryGoal(goals)).toMatchObject({ state: 'ready', enabled: true, capacityKWh: 5.12 });
      expect(plans.isSetupBatteryPlanOn('battery')).toBe(true);
      expect(facts.readSetupReview()?.steps.find((step) => step.id === 'prices')?.status).toBe('next');
    });

    it('keeps an accepted device-page save over an older return refresh', async () => {
      const { DEFAULT_CONTINUOUS_BATTERY_PLAN_CONFIG } = await import('../../shared-domain/src/settings/continuousBatteryPlan.ts');
      const { goals, state } = await load();
      manageBattery(state);
      const plans = await import('../src/ui/setupBatteryPlan.ts');
      let finishRead: (value: Record<string, unknown>) => void = () => {};
      savedPlans.mockImplementationOnce(() => new Promise((resolve) => { finishRead = resolve; }));
      const refresh = plans.loadSetupBatteryPlans();
      plans.acceptSetupBatteryPlans({
        battery: { ...DEFAULT_CONTINUOUS_BATTERY_PLAN_CONFIG, enabled: true, usableCapacityKWh: 5.12 },
      });
      finishRead({});
      await refresh;
      expect(batteryGoal(goals)).toMatchObject({ state: 'ready', enabled: true, capacityKWh: 5.12 });
    });

    it('accepts a device-page save without losing its Prices requirement to a failed read', async () => {
      const { DEFAULT_CONTINUOUS_BATTERY_PLAN_CONFIG } = await import('../../shared-domain/src/settings/continuousBatteryPlan.ts');
      const { goals, facts, state } = await load();
      manageBattery(state);
      facts.publishSetupPower({ state: 'received' });
      facts.publishSetupHardCapRead(true, {
        capacityEnabled: false, gridImportLimitKw: null, limitKw: 10, marginKw: 0.2,
        dryRun: true, periodMinutes: 60, followMonthPeak: false,
      });
      facts.publishSetupPrices({
        respondToPrices: true, budgetShapesByPrice: false,
        status: { state: 'open', summary: 'Choose your Norway price settings.' },
      });
      const plans = await import('../src/ui/setupBatteryPlan.ts');
      await plans.loadSetupBatteryPlans();
      expect(facts.readSetupPath()).toEqual({ state: 'complete' });
      plans.acceptSetupBatteryPlans({ battery: { ...DEFAULT_CONTINUOUS_BATTERY_PLAN_CONFIG, enabled: true } });
      savedPlans.mockRejectedValueOnce(new Error('later read unavailable'));
      await plans.loadSetupBatteryPlans();
      expect(batteryGoal(goals)).toMatchObject({ state: 'ready', enabled: true });
      expect(facts.readSetupReview()?.steps.find((step) => step.id === 'prices')?.status).toBe('next');
    });

    it('says why PELS cannot plan a battery it cannot drive', async () => {
      const { goals, state } = await load();
      manageBattery(state, { ...battery, batteryControl: 'needs_homey_api_key' } as Device);
      expect(batteryGoal(goals)).toEqual({
        state: 'blocked',
        reason: 'Add a Homey API key with Flow permission to let PELS execute the battery plan.',
        focus: 'battery-api-key',
      });
      expect(goals.resolveSetupGoalChoices()).toMatchObject({ hasActions: false });
      state.latestDevices = [battery];
      const plans = await import('../src/ui/setupBatteryPlan.ts');
      await plans.loadSetupBatteryPlans();
      expect(batteryGoal(goals)).toMatchObject({ state: 'ready' });
      expect(goals.resolveSetupGoalChoices()).toMatchObject({ hasActions: true });
    });

    it('includes a battery whose owner turned Managed off and points to the switch', async () => {
      const { goals, state } = await load();
      manageBattery(state);
      state.batteryControl = { status: 'resolved', devices: { battery: false } };
      expect(batteryGoal(goals)).toMatchObject({ state: 'blocked', focus: 'managed' });
      expect(goals.resolveSetupGoalChoices()).toMatchObject({ hasActions: false });
    });

    it('explains local and observe-only batteries without offering a plan', async () => {
      const { goals, state } = await load({ 'area-battery': 'garage' });
      manageBattery(state, { ...battery, batteryControl: 'controlled_through_local_device' });
      state.latestDevices.push(
        { ...battery, id: 'observe-only', batteryControl: 'observe_only' },
        { ...battery, id: 'area-battery' },
      );
      expect(ready(goals.resolveSetupGoalChoices())).toMatchObject([
        { id: 'battery', battery: { state: 'observe_only', reason: expect.stringContaining('local network device') } },
        { id: 'observe-only', battery: { state: 'observe_only' } },
      ]);
      expect(goals.resolveSetupGoalChoices()).toMatchObject({ hasActions: false });
    });

    it('rejects a stale enable but allows an existing plan to be turned off', async () => {
      const { state } = await load();
      manageBattery(state, { ...battery, batteryControl: 'needs_homey_api_key' });
      const plans = await import('../src/ui/setupBatteryPlan.ts');
      await plans.loadSetupBatteryPlans();
      await expect(plans.saveSetupBatteryPlan('battery', true, 5.12)).rejects.toThrow('Review battery setup');
      expect(savePlan).not.toHaveBeenCalled();

      const { DEFAULT_CONTINUOUS_BATTERY_PLAN_CONFIG } = await import('../../shared-domain/src/settings/continuousBatteryPlan.ts');
      plans.acceptSetupBatteryPlans({
        battery: { ...DEFAULT_CONTINUOUS_BATTERY_PLAN_CONFIG, enabled: true, usableCapacityKWh: 5.12, priceUnit: 'EUR/kWh' },
      });
      await plans.saveSetupBatteryPlan('battery', false, null);
      expect(savePlan).toHaveBeenCalledWith('battery', expect.objectContaining({ enabled: false }));
    });

    it('saves the plan on with the entered capacity, in the current price unit and with no wear allowance', async () => {
      const { state } = await load();
      manageBattery(state);
      const plans = await import('../src/ui/setupBatteryPlan.ts');
      await plans.loadSetupBatteryPlans();
      await expect(plans.saveSetupBatteryPlan('battery', true, null)).rejects.toThrow('usable capacity');
      await plans.saveSetupBatteryPlan('battery', true, 5.12);
      expect(savePlan).toHaveBeenCalledWith('battery', expect.objectContaining({
        enabled: true, usableCapacityKWh: 5.12, priceUnit: 'EUR/kWh', wearCostPerKWh: 0,
        exportPolicy: { kind: 'household_only' },
      }));
      // The saved map is read again, so the row shows what was stored.
      expect(savedPlans).toHaveBeenCalledTimes(2);
    });

    it('refuses to carry a wear allowance saved in another price unit', async () => {
      const { DEFAULT_CONTINUOUS_BATTERY_PLAN_CONFIG } = await import('../../shared-domain/src/settings/continuousBatteryPlan.ts');
      savedPlans.mockResolvedValue({ battery: { ...DEFAULT_CONTINUOUS_BATTERY_PLAN_CONFIG, priceUnit: 'NOK/kWh' } });
      const { state } = await load();
      manageBattery(state);
      const plans = await import('../src/ui/setupBatteryPlan.ts');
      await plans.loadSetupBatteryPlans();
      await expect(plans.saveSetupBatteryPlan('battery', true, 10)).rejects.toThrow('price unit changed');
      expect(savePlan).not.toHaveBeenCalled();
    });
  });

  it('decides nothing while the device list is still loading', async () => {
    const { goals, state } = await load();
    state.devicesLoaded = false;
    expect(goals.resolveSetupGoalChoices()).toEqual({ state: 'loading' });
  });
});
