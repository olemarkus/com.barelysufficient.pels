import {
  mockHomeyInstance,
  setMockDrivers,
  MockDriver,
  MockDevice,
} from '../mocks/homey';
import { createApp, cleanupApps } from '../utils/appTestUtils';

// Use fake timers for setInterval only to prevent resource leaks from periodic refresh
vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });

// Mock CapacityGuard to capture limit updates.
const capacityGuardInstances: any[] = [];
vi.mock('../../lib/power/capacityGuard', () => ({
  default: class MockCapacityGuard {
    public setLimit = vi.fn();
    public setSoftMargin = vi.fn();
    public setSoftLimitProvider = vi.fn();
    public setShortfallThresholdProvider = vi.fn();
    public reportTotalPower = vi.fn();
    public headroom = vi.fn().mockReturnValue(0);
    public isSheddingActive = vi.fn().mockReturnValue(false);
    public isInShortfall = vi.fn().mockReturnValue(false);
    public getSoftLimit = vi.fn().mockReturnValue(10);
    public activateShedding = vi.fn();
    public releaseShedding = vi.fn();
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

  it('reloads the capacity scalars when settings change', async () => {
    const app = createApp();
    await app.onInit();

    expect(capacityGuardInstances.length).toBe(1);

    // Change limit and margin via settings events.
    mockHomeyInstance.settings.set('capacity_limit_kw', 7);
    mockHomeyInstance.settings.set('capacity_margin_kw', 0.4);
    await new Promise((resolve) => setTimeout(resolve, 0));

    // Nothing mirrors the scalars any more — the reload IS the propagation.
    expect((app as any).capacitySettings).toMatchObject({ limitKw: 7, marginKw: 0.4 });
  });
});
