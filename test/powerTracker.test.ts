import {
  mockHomeyInstance,
  MockDevice,
  MockDriver,
  setMockDrivers,
} from './mocks/homey';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const MyApp = require('../app');

describe('power tracker integration', () => {
  beforeEach(() => {
    mockHomeyInstance.settings.removeAllListeners();
    mockHomeyInstance.settings.clear();
    setMockDrivers({
      driverA: new MockDriver('driverA', [new MockDevice('dev-1', 'Heater', ['onoff'])]),
    });
  });

  it('accumulates kWh from W samples correctly', async () => {
    const app = new MyApp();
    await app.onInit();

    const start = Date.now();
    // 1 kW for 30 minutes => 0.5 kWh
    await app['recordPowerSample'](1000, start);
    await app['recordPowerSample'](1000, start + 30 * 60 * 1000);

    const bucketKey = new Date(app['truncateToHour'](start)).toISOString();
    const state = mockHomeyInstance.settings.get('power_tracker_state');
    expect(state.buckets[bucketKey]).toBeCloseTo(0.5, 3);
  });

  it('reloads tracker state when settings change', async () => {
    const app = new MyApp();
    await app.onInit();

    // Simulate persisted state being cleared via settings UI.
    mockHomeyInstance.settings.set('power_tracker_state', {});

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(app['powerTracker'].buckets).toBeUndefined();
  });
});
