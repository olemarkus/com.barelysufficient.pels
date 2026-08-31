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
type MockCapacityGuardInstance = {
  setLimit: ReturnType<typeof vi.fn>;
  setSoftMargin: ReturnType<typeof vi.fn>;
  setSoftLimitProvider: ReturnType<typeof vi.fn>;
  setShortfallThresholdProvider: ReturnType<typeof vi.fn>;
  reportTotalPower: ReturnType<typeof vi.fn>;
  headroom: ReturnType<typeof vi.fn>;
  isSheddingActive: ReturnType<typeof vi.fn>;
  isInShortfall: ReturnType<typeof vi.fn>;
  getSoftLimit: ReturnType<typeof vi.fn>;
  activateShedding: ReturnType<typeof vi.fn>;
  releaseShedding: ReturnType<typeof vi.fn>;
  checkShortfall: ReturnType<typeof vi.fn>;
};
const capacityGuardInstances: MockCapacityGuardInstance[] = [];
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
    constructor(opts: { limitKw?: number; softMarginKw?: number } = {}) {
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
    expect(app.capacitySettings).toMatchObject({ limitKw: 7, marginKw: 0.4 });
  });
});
