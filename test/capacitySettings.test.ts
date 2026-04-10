import {
  mockHomeyInstance,
  setMockDrivers,
  MockDriver,
  MockDevice,
} from './mocks/homey';
import { createApp, cleanupApps } from './utils/appTestUtils';

// Use fake timers for setInterval only to prevent resource leaks from periodic refresh
vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });

// Mock CapacityGuard to capture limit updates.
const capacityGuardInstances: any[] = [];
vi.mock('../lib/core/capacityGuard', () => ({
  default: class MockCapacityGuard {
    public setLimit = vi.fn();
    public setSoftMargin = vi.fn();
    public setSoftLimitProvider = vi.fn();
    public setShortfallThresholdProvider = vi.fn();
    public reportTotalPower = vi.fn();
    public getLastTotalPower = vi.fn().mockReturnValue(null);
    public headroom = vi.fn().mockReturnValue(0);
    public getHeadroom = vi.fn().mockReturnValue(0);
    public getRestoreMargin = vi.fn().mockReturnValue(0.2);
    public isSheddingActive = vi.fn().mockReturnValue(false);
    public isInShortfall = vi.fn().mockReturnValue(false);
    public getSoftLimit = vi.fn().mockReturnValue(10);
    public setSheddingActive = vi.fn();
    public checkShortfall = vi.fn();
    constructor(opts: any = {}) {
      // Call setters once to mirror constructor usage.
      this.setLimit(opts.limitKw ?? 10);
      this.setSoftMargin(opts.softMarginKw ?? 0);
      capacityGuardInstances.push(this);
    }
  },
}));

describe('capacity settings propagation', () => {
  beforeEach(() => {
    mockHomeyInstance.settings.removeAllListeners();
    mockHomeyInstance.settings.clear();
    capacityGuardInstances.splice(0, capacityGuardInstances.length);
    setMockDrivers({
      driverA: new MockDriver('driverA', [new MockDevice('dev-1', 'Heater', ['target_temperature'])]),
    });
    vi.clearAllTimers();
  });

  afterEach(async () => {
    await cleanupApps();
    vi.clearAllTimers();
  });

  it('updates CapacityGuard when settings change', async () => {
    const app = createApp();
    await app.onInit();

    expect(capacityGuardInstances.length).toBe(1);
    const guard = capacityGuardInstances[0];

    // Change limit and margin via settings events.
    mockHomeyInstance.settings.set('capacity_limit_kw', 7);
    mockHomeyInstance.settings.set('capacity_margin_kw', 0.4);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(guard.setLimit).toHaveBeenLastCalledWith(7);
    expect(guard.setSoftMargin).toHaveBeenLastCalledWith(0.4);
    // Note: Guard no longer has setDryRun - dry run mode is handled by Plan
  });
});
