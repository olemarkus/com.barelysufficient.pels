import {
  mockHomeyInstance,
  setMockDrivers,
  MockDriver,
  MockDevice,
} from './mocks/homey';
import { createApp, cleanupApps } from './utils/appTestUtils';

// Use fake timers for setInterval only to prevent resource leaks from periodic refresh
jest.useFakeTimers({ doNotFake: ['setTimeout', 'setImmediate', 'clearTimeout', 'clearImmediate', 'Date'] });

// Mock CapacityGuard to capture limit updates.
const capacityGuardInstances: any[] = [];
jest.mock('../capacityGuard', () => {
  return class MockCapacityGuard {
    public setLimit = jest.fn();
    public setSoftMargin = jest.fn();
    public setDryRun = jest.fn();
    public setSoftLimitProvider = jest.fn();
    public start = jest.fn();
    public stop = jest.fn();
    public reportTotalPower = jest.fn();
    public getLastTotalPower = jest.fn().mockReturnValue(null);
    public requestOn = jest.fn().mockReturnValue(true);
    public forceOff = jest.fn();
    public hasCapacity = jest.fn().mockReturnValue(true);
    public headroom = jest.fn().mockReturnValue(0);
    public setControllables = jest.fn();
    public isSheddingActive = jest.fn().mockReturnValue(false);
    public isInShortfall = jest.fn().mockReturnValue(false);
    public getSoftLimit = jest.fn().mockReturnValue(10);
    constructor(opts: any = {}) {
      // Call setters once to mirror constructor usage.
      this.setLimit(opts.limitKw ?? 10);
      this.setSoftMargin(opts.softMarginKw ?? 0);
      capacityGuardInstances.push(this);
    }
  };
});

describe('capacity settings propagation', () => {
  beforeEach(() => {
    mockHomeyInstance.settings.removeAllListeners();
    mockHomeyInstance.settings.clear();
    capacityGuardInstances.splice(0, capacityGuardInstances.length);
    setMockDrivers({
      driverA: new MockDriver('driverA', [new MockDevice('dev-1', 'Heater', ['target_temperature'])]),
    });
    jest.clearAllTimers();
  });

  afterEach(async () => {
    await cleanupApps();
    jest.clearAllTimers();
  });

  it('updates CapacityGuard when settings change', async () => {
    const app = createApp();
    await app.onInit();

    expect(capacityGuardInstances.length).toBe(1);
    const guard = capacityGuardInstances[0];

    // Change limit and margin via settings events.
    mockHomeyInstance.settings.set('capacity_limit_kw', 7);
    mockHomeyInstance.settings.set('capacity_margin_kw', 0.4);
    mockHomeyInstance.settings.set('capacity_dry_run', false);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(guard.setLimit).toHaveBeenLastCalledWith(7);
    expect(guard.setSoftMargin).toHaveBeenLastCalledWith(0.4);
    const calls = (guard.setDryRun as jest.Mock).mock.calls;
    expect(calls[calls.length - 1][0]).toBe(false);
  });
});
