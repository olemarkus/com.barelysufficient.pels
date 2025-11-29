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
});
