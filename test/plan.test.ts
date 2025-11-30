import {
  mockHomeyInstance,
  setMockDrivers,
  MockDevice,
  MockDriver,
} from './mocks/homey';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const MyApp = require('../app');

// Factory for creating a Hoiax Connected 300 water heater mock
function createHoiaxWaterHeater(id: string, name: string = 'Connected 300') {
  const device = new MockDevice(id, name, [
    'meter_power.in_tank',
    'meter_power',
    'measure_power',
    'measure_humidity.fill_level',
    'target_temperature',
    'measure_temperature',
    'onoff.hwBoost',
    'onoff',
    'max_power_3000',
  ]);
  // Set realistic default values
  device.setCapabilityValue('measure_power', 0);
  device.setCapabilityValue('target_temperature', 65);
  device.setCapabilityValue('onoff', true);
  device.setCapabilityValue('max_power_3000', '3'); // Max power by default
  return device;
}

describe('Device plan snapshot', () => {
  beforeEach(() => {
    mockHomeyInstance.settings.removeAllListeners();
    mockHomeyInstance.settings.clear();
  });

  it('marks lower-priority devices as shed when over soft limit', async () => {
    const dev1 = new MockDevice('dev-1', 'Heater A', ['target_temperature', 'measure_power']);
    const dev2 = new MockDevice('dev-2', 'Heater B', ['target_temperature', 'measure_power']);
    await dev1.setCapabilityValue('measure_power', 5000); // 5 kW
    await dev2.setCapabilityValue('measure_power', 4000); // 4 kW

    setMockDrivers({
      driverA: new MockDriver('driverA', [dev1, dev2]),
    });

    // Priorities: dev2 sheds first.
    mockHomeyInstance.settings.set('capacity_priorities', { Home: { 'dev-1': 2, 'dev-2': 1 } });

    const app = new MyApp();
    await app.onInit();

    // Deterministic soft limit for the test.
    (app as any).computeDynamicSoftLimit = () => 9;
    if ((app as any).capacityGuard?.setSoftLimitProvider) {
      (app as any).capacityGuard.setSoftLimitProvider(() => 9);
    }

    // Report 12 kW total; soft limit defaults to 9.8 kW (10 - 0.2).
    await (app as any).recordPowerSample(12000);

    const plan = mockHomeyInstance.settings.get('device_plan_snapshot');
    expect(plan).toBeTruthy();
    const dev2Plan = plan.devices.find((d: any) => d.id === 'dev-2');
    expect(dev2Plan?.plannedState).toBe('shed');
    const dev1Plan = plan.devices.find((d: any) => d.id === 'dev-1');
    expect(dev1Plan?.plannedState).toBe('keep');
  });

  it('executes shedding action when plan says shed and dry run is off', async () => {
    const dev1 = new MockDevice('dev-1', 'Heater A', ['target_temperature']);
    setMockDrivers({
      driverA: new MockDriver('driverA', [dev1]),
    });

    mockHomeyInstance.settings.set('capacity_dry_run', false);

    const app = new MyApp();
    await app.onInit();

    const spy = jest.fn().mockResolvedValue(undefined);
    (app as any).applySheddingToDevice = spy;

    const plan = {
      devices: [
        {
          id: 'dev-1',
          name: 'Heater A',
          plannedState: 'shed',
          currentState: 'on',
          plannedTarget: null,
          currentTarget: null,
          controllable: true,
        },
      ],
    };

    await (app as any).applyPlanActions(plan);
    expect(spy).toHaveBeenCalledWith('dev-1', 'Heater A');
  });

  it('ignores non-controllable devices when planning shedding', async () => {
    const controllable = new MockDevice('dev-ctl', 'Heater A', ['target_temperature']);
    const nonCtl = new MockDevice('dev-non', 'Heater B', ['target_temperature']);
    setMockDrivers({
      driverA: new MockDriver('driverA', [controllable, nonCtl]),
    });

    mockHomeyInstance.settings.set('controllable_devices', { 'dev-ctl': true, 'dev-non': false });

    const app = new MyApp();
    await app.onInit();

    // Force soft limit low and total high to trigger shedding.
    (app as any).computeDynamicSoftLimit = () => 1;
    if ((app as any).capacityGuard?.setSoftLimitProvider) {
      (app as any).capacityGuard.setSoftLimitProvider(() => 1);
    }
    await (app as any).recordPowerSample(5000); // 5 kW total, over limit

    const plan = mockHomeyInstance.settings.get('device_plan_snapshot');
    const ctlPlan = plan.devices.find((d: any) => d.id === 'dev-ctl');
    const nonCtlPlan = plan.devices.find((d: any) => d.id === 'dev-non');

    expect(ctlPlan?.plannedState).toBe('shed');
    expect(nonCtlPlan?.plannedState).toBe('keep');
  });

  it('updates planned target when switching modes', async () => {
    const dev1 = new MockDevice('dev-1', 'Heater A', ['target_temperature']);
    setMockDrivers({
      driverA: new MockDriver('driverA', [dev1]),
    });

    mockHomeyInstance.settings.set('mode_device_targets', { Home: { 'dev-1': 19 }, Comfort: { 'dev-1': 21 } });
    mockHomeyInstance.settings.set('capacity_mode', 'Home');

    const app = new MyApp();
    await app.onInit();

    // Ensure plan exists for Home.
    await (app as any).recordPowerSample(1000);
    let plan = mockHomeyInstance.settings.get('device_plan_snapshot');
    const homePlan = plan.devices.find((d: any) => d.id === 'dev-1');
    expect(homePlan?.plannedTarget).toBe(19);

    // Switch mode; settings listener should rebuild snapshot/plan.
    mockHomeyInstance.settings.set('capacity_mode', 'Comfort');
    await new Promise((resolve) => setTimeout(resolve, 0));

    plan = mockHomeyInstance.settings.get('device_plan_snapshot');
    const comfortPlan = plan.devices.find((d: any) => d.id === 'dev-1');
    expect(comfortPlan?.plannedTarget).toBe(21);
  });

  it('keeps device shed until headroom exceeds restore margin', async () => {
    const dev1 = new MockDevice('dev-1', 'Heater A', ['target_temperature']);
    await dev1.setCapabilityValue('measure_power', 2000);
    setMockDrivers({
      driverA: new MockDriver('driverA', [dev1]),
    });

    const app = new MyApp();
    await app.onInit();

    // Force soft limit to 1 kW and total to 1.1 kW -> deficit triggers shed.
    (app as any).computeDynamicSoftLimit = () => 1;
    if ((app as any).capacityGuard?.setSoftLimitProvider) {
      (app as any).capacityGuard.setSoftLimitProvider(() => 1);
    }
    await (app as any).recordPowerSample(1100);
    let plan = mockHomeyInstance.settings.get('device_plan_snapshot');
    expect(plan.devices.find((d: any) => d.id === 'dev-1')?.plannedState).toBe('shed');

    // Slight headroom (+0.05 kW) should not restore because below restore margin (0.2).
    (app as any).computeDynamicSoftLimit = () => 1.15;
    if ((app as any).capacityGuard?.setSoftLimitProvider) {
      (app as any).capacityGuard.setSoftLimitProvider(() => 1.15);
    }
    await (app as any).recordPowerSample(1100);
    plan = mockHomeyInstance.settings.get('device_plan_snapshot');
    expect(plan.devices.find((d: any) => d.id === 'dev-1')?.plannedState).toBe('shed');

    // Large headroom should allow restoration.
    (app as any).computeDynamicSoftLimit = () => 2;
    if ((app as any).capacityGuard?.setSoftLimitProvider) {
      (app as any).capacityGuard.setSoftLimitProvider(() => 2);
    }
    await (app as any).recordPowerSample(1100);
    plan = mockHomeyInstance.settings.get('device_plan_snapshot');
    expect(plan.devices.find((d: any) => d.id === 'dev-1')?.plannedState).toBe('keep');
  });

  it('does not turn a shed device back on if headroom is below its power need', async () => {
    const dev1 = new MockDevice('dev-1', 'Heater A', ['target_temperature', 'onoff']);
    setMockDrivers({
      driverA: new MockDriver('driverA', [dev1]),
    });

    mockHomeyInstance.settings.set('capacity_dry_run', false);

    const app = new MyApp();
    await app.onInit();

    // Force headroom small; monkey-patch guard headroom and margin.
    (app as any).capacitySettings.marginKw = 0.2;
    (app as any).capacityGuard.getHeadroom = () => 0.3;

    const plan = {
      devices: [
        {
          id: 'dev-1',
          name: 'Heater A',
          plannedState: 'keep',
          currentState: 'off',
          plannedTarget: null,
          currentTarget: null,
          powerKw: 2, // needs at least 2 + margin headroom
          controllable: true,
        },
      ],
    };

    const findSpy = jest.fn();
    (app as any).findDeviceInstance = findSpy;

    await (app as any).applyPlanActions(plan);
    expect(findSpy).not.toHaveBeenCalled();
  });

  it('keeps planned state as shed when headroom is below device need even after turn-off', async () => {
    const dev1 = new MockDevice('dev-1', 'Heater A', ['target_temperature', 'onoff', 'measure_power']);
    await dev1.setCapabilityValue('measure_power', 2500); // 2.5 kW
    setMockDrivers({
      driverA: new MockDriver('driverA', [dev1]),
    });

    const app = new MyApp();
    await app.onInit();

    // Force soft limit to 2 kW and total to 2.1 kW -> shed.
    (app as any).computeDynamicSoftLimit = () => 2;
    if ((app as any).capacityGuard?.setSoftLimitProvider) {
      (app as any).capacityGuard.setSoftLimitProvider(() => 2);
    }
    await (app as any).recordPowerSample(2100);
    let plan = mockHomeyInstance.settings.get('device_plan_snapshot');
    expect(plan.devices.find((d: any) => d.id === 'dev-1')?.plannedState).toBe('shed');

    // Simulate device now off, but headroom still below need (2.5 + margin).
    plan = (app as any).buildDevicePlanSnapshot([
      {
        id: 'dev-1',
        name: 'Heater A',
        targets: [],
        powerKw: 2.5,
        priority: 1,
        currentOn: false,
        controllable: true,
      },
    ]);
    const nextState = plan.devices.find((d: any) => d.id === 'dev-1');
    expect(nextState?.plannedState).toBe('shed');
  });

  it('sheds a controllable device when overshooting with real power sample (non-dry-run)', async () => {
    const dev1 = new MockDevice('dev-1', 'Heater A', ['target_temperature', 'onoff', 'measure_power']);
    await dev1.setCapabilityValue('measure_power', 2000); // 2 kW
    await dev1.setCapabilityValue('onoff', true);
    setMockDrivers({
      driverA: new MockDriver('driverA', [dev1]),
    });

    mockHomeyInstance.settings.set('capacity_dry_run', false);
    mockHomeyInstance.settings.set('controllable_devices', { 'dev-1': true });

    const app = new MyApp();
    await app.onInit();

    // Force soft limit to 1 kW so 2 kW total is an overshoot.
    (app as any).computeDynamicSoftLimit = () => 1;
    if ((app as any).capacityGuard?.setSoftLimitProvider) {
      (app as any).capacityGuard.setSoftLimitProvider(() => 1);
    }

    const shedSpy = jest.fn().mockResolvedValue(undefined);
    (app as any).applySheddingToDevice = shedSpy;

    await (app as any).recordPowerSample(2000);

    expect(shedSpy).toHaveBeenCalledWith('dev-1', 'Heater A');
    const plan = mockHomeyInstance.settings.get('device_plan_snapshot');
    const planned = plan.devices.find((d: any) => d.id === 'dev-1');
    expect(planned?.plannedState).toBe('shed');
  });

  it('sheds multiple lowest-priority devices until headroom is non-negative', async () => {
    const dev1 = new MockDevice('dev-1', 'Heater A', ['target_temperature', 'onoff', 'measure_power']);
    const dev2 = new MockDevice('dev-2', 'Heater B', ['target_temperature', 'onoff', 'measure_power']);
    await dev1.setCapabilityValue('measure_power', 1700); // 1.7 kW
    await dev2.setCapabilityValue('measure_power', 1000); // 1.0 kW
    await dev1.setCapabilityValue('onoff', true);
    await dev2.setCapabilityValue('onoff', true);

    setMockDrivers({
      driverA: new MockDriver('driverA', [dev1, dev2]),
    });

    // Mark both devices controllable.
    mockHomeyInstance.settings.set('controllable_devices', { 'dev-1': true, 'dev-2': true });
    mockHomeyInstance.settings.set('capacity_dry_run', false);

    const app = new MyApp();
    await app.onInit();

    // Force soft limit to about 3.1 kW so total 5.63 kW is an overshoot of ~2.53 kW.
    (app as any).computeDynamicSoftLimit = () => 3.1;
    if ((app as any).capacityGuard?.setSoftLimitProvider) {
      (app as any).capacityGuard.setSoftLimitProvider(() => 3.1);
    }

    const shedSpy = jest.spyOn(app as any, 'applySheddingToDevice').mockResolvedValue(undefined);

    await (app as any).recordPowerSample(5630); // 5.63 kW total

    const plan = mockHomeyInstance.settings.get('device_plan_snapshot');
    const shedIds = plan.devices.filter((d: any) => d.plannedState === 'shed').map((d: any) => d.id);
    expect(shedIds).toEqual(expect.arrayContaining(['dev-1', 'dev-2']));
    expect(shedSpy).toHaveBeenCalledWith('dev-1', 'Heater A');
    expect(shedSpy).toHaveBeenCalledWith('dev-2', 'Heater B');
  });

  it('throttles repeated shedding commands for the same device', async () => {
    const dev1 = new MockDevice('dev-1', 'Heater A', ['onoff']);
    await dev1.setCapabilityValue('onoff', true);
    setMockDrivers({
      driverA: new MockDriver('driverA', [dev1]),
    });

    mockHomeyInstance.settings.set('capacity_dry_run', false);

    const app = new MyApp();
    await app.onInit();

    // Inject mock homeyApi for the test
    const mockHomeyApi = {
      devices: {
        setCapabilityValue: jest.fn().mockResolvedValue(undefined),
      },
    };
    (app as any).homeyApi = mockHomeyApi;

    // Clear snapshot so the second call would normally try again.
    (app as any).latestTargetSnapshot = [];

    await (app as any).applySheddingToDevice('dev-1', 'Heater A');
    // Simulate plan still thinks it is on to force a second attempt.
    (app as any).latestTargetSnapshot = [];
    await (app as any).applySheddingToDevice('dev-1', 'Heater A');

    expect(mockHomeyApi.devices.setCapabilityValue).toHaveBeenCalledTimes(1);
  });

  it('does not repeatedly shed the same device across consecutive samples (flap guard)', async () => {
    const dev1 = new MockDevice('dev-1', 'Heater A', ['onoff', 'measure_power', 'target_temperature']);
    await dev1.setCapabilityValue('measure_power', 2000); // 2 kW
    await dev1.setCapabilityValue('onoff', true);
    await dev1.setCapabilityValue('target_temperature', 20);

    setMockDrivers({
      driverA: new MockDriver('driverA', [dev1]),
    });

    mockHomeyInstance.settings.set('controllable_devices', { 'dev-1': true });
    mockHomeyInstance.settings.set('capacity_dry_run', false);

    const app = new MyApp();
    await app.onInit();

    // Inject mock homeyApi for the test
    const mockHomeyApi = {
      devices: {
        setCapabilityValue: jest.fn().mockResolvedValue(undefined),
      },
    };
    (app as any).homeyApi = mockHomeyApi;

    // Force a low soft limit so the device must be shed.
    (app as any).computeDynamicSoftLimit = () => 1;
    if ((app as any).capacityGuard?.setSoftLimitProvider) {
      (app as any).capacityGuard.setSoftLimitProvider(() => 1);
    }

    // First overshoot triggers shedding.
    await (app as any).recordPowerSample(5000);
    // Wait for async applyPlanActions to complete before second sample.
    await new Promise((r) => setTimeout(r, 100));
    // Second overshoot arrives before cooldown; should not call setCapabilityValue again.
    await (app as any).recordPowerSample(5000);
    await new Promise((r) => setTimeout(r, 100));

    expect(mockHomeyApi.devices.setCapabilityValue).toHaveBeenCalledTimes(1);
  });

  it('uses settings.load as power when measure_power is zero', async () => {
    const app = new MyApp();
    await app.onInit();

    const sampleDevice = {
      id: 'thermostat-1',
      name: 'Room Thermostat',
      capabilities: ['onoff', 'target_temperature', 'measure_power'],
      capabilitiesObj: {
        onoff: { value: false },
        target_temperature: { value: 22, units: '°C' },
        measure_power: { value: 0 },
      },
      settings: { load: 450 },
    };

    const parsed = (app as any).parseDeviceList([sampleDevice]);
    expect(parsed[0].powerKw).toBeCloseTo(0.45, 2);
    expect(parsed[0].targets[0].value).toBe(22);
  });

  it('does not count already-off devices toward shedding need', async () => {
    const devOn = new MockDevice('dev-on', 'On Device', ['target_temperature', 'onoff', 'measure_power']);
    const devOff = new MockDevice('dev-off', 'Off Device', ['target_temperature', 'onoff', 'measure_power']);
    await devOn.setCapabilityValue('measure_power', 1700); // 1.7 kW
    await devOn.setCapabilityValue('onoff', true);
    await devOff.setCapabilityValue('measure_power', 1000); // 1.0 kW but already off
    await devOff.setCapabilityValue('onoff', false);

    setMockDrivers({
      driverA: new MockDriver('driverA', [devOn, devOff]),
    });

    mockHomeyInstance.settings.set('controllable_devices', { 'dev-on': true, 'dev-off': true });
    mockHomeyInstance.settings.set('capacity_dry_run', false);

    const app = new MyApp();
    await app.onInit();

    // Soft limit 3 kW, total 6.3 kW -> need ~3.3 kW. Off device should not be counted as shed.
    (app as any).computeDynamicSoftLimit = () => 3;
    if ((app as any).capacityGuard?.setSoftLimitProvider) {
      (app as any).capacityGuard.setSoftLimitProvider(() => 3);
    }

    const shedSpy = jest.spyOn(app as any, 'applySheddingToDevice').mockResolvedValue(undefined);

    await (app as any).recordPowerSample(6300);

    expect(shedSpy).toHaveBeenCalledWith('dev-on', 'On Device');
    expect(shedSpy).not.toHaveBeenCalledWith('dev-off', 'Off Device');
  });

  it('triggers capacity_shortfall when deficit remains after shedding all controllables', async () => {
    const dev1 = new MockDevice('dev-1', 'Heater A', ['onoff']);
    setMockDrivers({
      driverA: new MockDriver('driverA', [dev1]),
    });
    mockHomeyInstance.settings.set('controllable_devices', { 'dev-1': true });

    const triggerSpy = jest.fn().mockReturnValue({ catch: jest.fn() });
    const originalGetTrigger = mockHomeyInstance.flow.getTriggerCard as any;
    mockHomeyInstance.flow.getTriggerCard = ((id: string) => {
      if (id === 'capacity_shortfall') {
        return { trigger: triggerSpy };
      }
      return originalGetTrigger();
    }) as any;

    const app = new MyApp();
    await app.onInit();

    // Only 1 kW available to shed but deficit is ~3 kW (4 kW total, 1 kW soft).
    (app as any).latestTargetSnapshot = [
      {
        id: 'dev-1',
        name: 'Heater A',
        targets: [],
        powerKw: 1,
        currentOn: true,
        controllable: true,
      },
    ];
    (app as any).computeDynamicSoftLimit = () => 1;
    if ((app as any).capacityGuard?.setSoftLimitProvider) {
      (app as any).capacityGuard.setSoftLimitProvider(() => 1);
    }

    await (app as any).recordPowerSample(4000);
    expect(triggerSpy).toHaveBeenCalled();

    mockHomeyInstance.flow.getTriggerCard = originalGetTrigger;
  });

  it('does not trigger capacity_shortfall when controllables can cover the deficit', async () => {
    const dev1 = new MockDevice('dev-1', 'Heater A', ['onoff', 'measure_power']);
    const dev2 = new MockDevice('dev-2', 'Heater B', ['onoff', 'measure_power']);
    await dev1.setCapabilityValue('measure_power', 1500); // 1.5 kW
    await dev2.setCapabilityValue('measure_power', 1200); // 1.2 kW
    await dev1.setCapabilityValue('onoff', true);
    await dev2.setCapabilityValue('onoff', true);

    setMockDrivers({
      driverA: new MockDriver('driverA', [dev1, dev2]),
    });
    mockHomeyInstance.settings.set('controllable_devices', { 'dev-1': true, 'dev-2': true });

    const triggerSpy = jest.fn();
    const originalGetTrigger = mockHomeyInstance.flow.getTriggerCard as any;
    mockHomeyInstance.flow.getTriggerCard = ((id: string) => {
      if (id === 'capacity_shortfall') return { trigger: triggerSpy } as any;
      return originalGetTrigger();
    }) as any;

    const app = new MyApp();
    await app.onInit();

    // Soft limit 3.2 kW, total 5.6 kW -> need 2.4 kW, controllables can cover ~2.7 kW so no shortfall.
    (app as any).computeDynamicSoftLimit = () => 3.2;
    if ((app as any).capacityGuard?.setSoftLimitProvider) {
      (app as any).capacityGuard.setSoftLimitProvider(() => 3.2);
    }

    await (app as any).recordPowerSample(5600);
    expect(triggerSpy).not.toHaveBeenCalled();

    mockHomeyInstance.flow.getTriggerCard = originalGetTrigger;
  });

  it('does not restore immediately after shedding (prevents flapping)', async () => {
    const dev1 = new MockDevice('dev-1', 'Heater A', ['onoff', 'measure_power']);
    await dev1.setCapabilityValue('measure_power', 500);
    await dev1.setCapabilityValue('onoff', false); // assumed off after a shed event

    setMockDrivers({
      driverA: new MockDriver('driverA', [dev1]),
    });
    mockHomeyInstance.settings.set('controllable_devices', { 'dev-1': true });
    mockHomeyInstance.settings.set('capacity_dry_run', false);

    const app = new MyApp();
    await app.onInit();

    // Simulate recent shedding/overshoot.
    (app as any).lastSheddingMs = Date.now();
    if ((app as any).capacityGuard) {
      (app as any).capacityGuard.getHeadroom = () => 5; // plenty of headroom
      (app as any).capacityGuard.isSheddingActive = () => false;
    }

    const onSpy = jest.spyOn(dev1 as any, 'setCapabilityValue');

    const plan = {
      devices: [
        {
          id: 'dev-1',
          name: 'Heater A',
          plannedState: 'keep',
          currentState: 'off',
          plannedTarget: null,
          currentTarget: null,
          controllable: true,
          powerKw: 0.5,
        },
      ],
    };

    await (app as any).applyPlanActions(plan);

    expect(onSpy).not.toHaveBeenCalled();
  });

  it('uses settings.load as fallback power when device is off', async () => {
    const dev1 = new MockDevice('dev-1', 'Heater A', ['target_temperature', 'onoff']);
    dev1.setSettings({ load: 1200 }); // watts
    await dev1.setCapabilityValue('onoff', false);

    setMockDrivers({
      driverA: new MockDriver('driverA', [dev1]),
    });

    mockHomeyInstance.settings.set('capacity_dry_run', false);
    mockHomeyInstance.settings.set('controllable_devices', { 'dev-1': true });

    const app = new MyApp();
    await app.onInit();

    const snapshot = mockHomeyInstance.settings.get('target_devices_snapshot');
    const device = snapshot.find((d: any) => d.id === 'dev-1');
    expect(device.powerKw).toBeCloseTo(1.2, 3);
  });

  it('includes Hoiax water heater in device snapshot with target_temperature', async () => {
    const hoiax = createHoiaxWaterHeater('hoiax-1', 'Connected 300');
    await hoiax.setCapabilityValue('measure_power', 3000); // 3kW when heating
    await hoiax.setCapabilityValue('target_temperature', 65);

    setMockDrivers({
      hoiaxDriver: new MockDriver('hoiaxDriver', [hoiax]),
    });

    const app = new MyApp();
    await app.onInit();

    const snapshot = mockHomeyInstance.settings.get('target_devices_snapshot');
    expect(snapshot).toHaveLength(1);
    expect(snapshot[0]).toMatchObject({
      id: 'hoiax-1',
      name: 'Connected 300',
      powerKw: 3, // 3000W = 3kW
    });
    expect(snapshot[0].targets[0]).toMatchObject({
      id: 'target_temperature',
      value: 65,
    });
  });

  it('can shed Hoiax water heater when over capacity', async () => {
    const hoiax = createHoiaxWaterHeater('hoiax-1');
    await hoiax.setCapabilityValue('measure_power', 3000);
    await hoiax.setCapabilityValue('onoff', true);

    setMockDrivers({
      hoiaxDriver: new MockDriver('hoiaxDriver', [hoiax]),
    });

    mockHomeyInstance.settings.set('controllable_devices', { 'hoiax-1': true });
    mockHomeyInstance.settings.set('capacity_dry_run', false);

    const app = new MyApp();
    await app.onInit();

    // Inject mock homeyApi
    const setSpy = jest.fn().mockResolvedValue(undefined);
    (app as any).homeyApi = {
      devices: {
        setCapabilityValue: setSpy,
      },
    };

    // Force very low soft limit
    (app as any).computeDynamicSoftLimit = () => 1;
    if ((app as any).capacityGuard?.setSoftLimitProvider) {
      (app as any).capacityGuard.setSoftLimitProvider(() => 1);
    }

    // Report high power - should trigger shedding
    await (app as any).recordPowerSample(5000);
    await new Promise((r) => setTimeout(r, 100));

    // Verify the device was turned off
    expect(setSpy).toHaveBeenCalledWith({
      deviceId: 'hoiax-1',
      capabilityId: 'onoff',
      value: false,
    });
  });

  it('applies mode target temperature to Hoiax water heater', async () => {
    const hoiax = createHoiaxWaterHeater('hoiax-1');
    await hoiax.setCapabilityValue('target_temperature', 65);

    setMockDrivers({
      hoiaxDriver: new MockDriver('hoiaxDriver', [hoiax]),
    });

    // Configure Away mode with lower temp for water heater
    mockHomeyInstance.settings.set('mode_device_targets', { 
      Away: { 'hoiax-1': 45 },
      Home: { 'hoiax-1': 65 },
    });
    mockHomeyInstance.settings.set('capacity_dry_run', false);

    const app = new MyApp();
    await app.onInit();

    // Inject mock homeyApi
    const setSpy = jest.fn().mockResolvedValue(undefined);
    (app as any).homeyApi = {
      devices: {
        getDevices: async () => ({
          'hoiax-1': {
            id: 'hoiax-1',
            name: 'Connected 300',
            capabilities: ['target_temperature', 'onoff', 'max_power_3000'],
            capabilitiesObj: { 
              target_temperature: { value: 65 },
              onoff: { value: true },
            },
            settings: {},
          },
        }),
        setCapabilityValue: setSpy,
      },
    };

    // Trigger mode change via flow card
    const setModeListener = mockHomeyInstance.flow._actionCardListeners['set_capacity_mode'];
    await setModeListener({ mode: 'Away' });

    // Verify target temperature was set to 45°C
    expect(setSpy).toHaveBeenCalledWith({
      deviceId: 'hoiax-1',
      capabilityId: 'target_temperature',
      value: 45,
    });
  });
});
