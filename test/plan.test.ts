import {
  mockHomeyInstance,
  setMockDrivers,
  MockDevice,
  MockDriver,
} from './mocks/homey';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const MyApp = require('../app');

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
});
