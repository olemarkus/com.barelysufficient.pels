import { AppSnapshotHelpers } from '../lib/app/appSnapshotHelpers';
import { TimerRegistry } from '../lib/app/timerRegistry';
import { mockHomeyInstance } from './mocks/homey';

describe('appSnapshotHelpers', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockHomeyInstance.settings.clear();
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('restarting periodic snapshot refresh replaces existing timers instead of duplicating them', () => {
    const helper = new AppSnapshotHelpers({
      homey: mockHomeyInstance as any,
      timers: new TimerRegistry(),
      getDeviceManager: () => ({ refreshSnapshot: vi.fn() } as any),
      getPlanEngine: () => undefined,
      getPlanService: () => ({
        syncLivePlanState: vi.fn().mockResolvedValue(undefined),
        syncHeadroomCardState: vi.fn(),
        getLatestPlanSnapshot: vi.fn(),
      } as any),
      getLatestTargetSnapshot: () => [],
      resolveManagedState: () => false,
      isCapacityControlEnabled: () => false,
      getStructuredLogger: () => undefined,
      logDebug: vi.fn(),
      error: vi.fn(),
      getNow: () => new Date('2026-03-21T10:00:00Z'),
      logPeriodicStatus: vi.fn(),
      disableUnsupportedDevices: vi.fn(),
      recordPowerSample: vi.fn().mockResolvedValue(undefined),
    });

    helper.startPeriodicSnapshotRefresh();
    const initialTimerCount = vi.getTimerCount();
    expect(initialTimerCount).toBeGreaterThan(0);

    helper.startPeriodicSnapshotRefresh();
    expect(vi.getTimerCount()).toBe(initialTimerCount);

    helper.stop();
    expect(vi.getTimerCount()).toBe(0);
  });
});
