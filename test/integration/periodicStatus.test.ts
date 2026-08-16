import { buildPeriodicStatusLogFields } from '../../lib/diagnostics/periodicStatus';
import { recordPowerSample, type PowerTrackerState } from '../../lib/power/tracker';
import { getHourBucketKey } from '../../lib/utils/dateUtils';

describe('periodic status used kWh', () => {
  it('reports usage from the current UTC hour bucket', async () => {
    let state: PowerTrackerState = {};
    const saveState = (nextState: PowerTrackerState) => { state = nextState; };
    const rebuildPlanFromCache = async () => { };

    const sampleStart = Date.UTC(2025, 0, 1, 0, 30, 0);
    await recordPowerSample({
      state,
      currentPowerW: 3000,
      nowMs: sampleStart,

      rebuildPlanFromCache,
      saveState,
    });
    await recordPowerSample({
      state,
      currentPowerW: 3000,
      nowMs: sampleStart + 15 * 60 * 1000,

      rebuildPlanFromCache,
      saveState,
    });

    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(sampleStart + 15 * 60 * 1000);
    const fields = buildPeriodicStatusLogFields({
      powerTracker: state,
      capacitySettings: { limitKw: 7, marginKw: 0.5 },
      operatingMode: 'Home',
      capacityDryRun: false,
    });
    nowSpy.mockRestore();

    expect(fields.homeId).toBe('main');
    expect(fields.softLimitKw).toBe(6.5);
    expect(fields.usedKWh).toBe(0.75);
    expect(fields.hourRemainingKWh).toBe(5.75);
  });

  it('uses UTC hour bucket for usage', () => {
    const nowMs = Date.UTC(2025, 0, 1, 12, 5, 0);
    const bucketKey = getHourBucketKey(nowMs);
    expect(bucketKey).toBe('2025-01-01T12:00:00.000Z');
  });

  it('labels soft limit separately from hourly usage budget', () => {
    const nowMs = Date.UTC(2025, 0, 1, 10, 55, 0);
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(nowMs);
    const fields = buildPeriodicStatusLogFields({
      capacityGuard: {
        getSoftLimit: () => 4,
        getShortfallThreshold: () => 5,
        isSheddingActive: () => false,
        isInShortfall: () => false,
      },
      powerTracker: {
        lastPowerW: 2480,
        buckets: {
          [getHourBucketKey(nowMs)]: 2.52,
        },
      },
      capacitySettings: { limitKw: 5, marginKw: 1 },
      operatingMode: 'Home',
      capacityDryRun: false,
    });
    nowSpy.mockRestore();

    expect(fields.softLimitKw).toBe(4);
    expect(fields.shortfallBudgetThresholdKw).toBe(5);
    expect(fields.shortfallBudgetHeadroomKw).toBe(2.52);
    expect(fields.hardCapHeadroomKw).toBe(2.52);
    expect(fields.usedKWh).toBe(2.52);
    expect(fields.hourRemainingKWh).toBeCloseTo(1.48, 8);
  });

  it('calls getSoftLimit at most once per invocation (no duplicate soft-limit provider calls)', () => {
    const nowMs = Date.UTC(2025, 0, 1, 10, 30, 0);
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(nowMs);
    let getSoftLimitCallCount = 0;
    buildPeriodicStatusLogFields({
      capacityGuard: {
        getSoftLimit: () => { getSoftLimitCallCount += 1; return 5.0; },
        getShortfallThreshold: () => 6,
        isSheddingActive: () => false,
        isInShortfall: () => false,
      },
      powerTracker: { lastPowerW: 3000 },
      capacitySettings: { limitKw: 6, marginKw: 1 },
      operatingMode: 'Home',
      capacityDryRun: false,
    });
    nowSpy.mockRestore();
    expect(getSoftLimitCallCount).toBe(1);
  });

  it('reports hard-cap breach amount in periodic status', () => {
    const nowMs = Date.UTC(2025, 0, 1, 10, 30, 0);
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(nowMs);
    const fields = buildPeriodicStatusLogFields({
      capacityGuard: {
        getSoftLimit: () => 4.8,
        getShortfallThreshold: () => 6,
        isSheddingActive: () => true,
        isInShortfall: () => false,
      },
      powerTracker: { lastPowerW: 7400 },
      capacitySettings: { limitKw: 6, marginKw: 1.2 },
      operatingMode: 'Home',
      capacityDryRun: false,
    });
    nowSpy.mockRestore();

    expect(fields.softHeadroomKw).toBeCloseTo(-2.6, 8);
    expect(fields.shortfallBudgetThresholdKw).toBe(6);
    expect(fields.shortfallBudgetHeadroomKw).toBeCloseTo(-1.4, 8);
    expect(fields.hardCapHeadroomKw).toBeCloseTo(-1.4, 8);
  });

  it('keeps physical hard-cap headroom separate from budget-derived shortfall headroom', () => {
    const nowMs = Date.UTC(2025, 0, 1, 10, 57, 0);
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(nowMs);
    const fields = buildPeriodicStatusLogFields({
      capacityGuard: {
        getSoftLimit: () => 4.8,
        getShortfallThreshold: () => 8.6,
        isSheddingActive: () => false,
        isInShortfall: () => false,
      },
      powerTracker: { lastPowerW: 5200 },
      capacitySettings: { limitKw: 6, marginKw: 1.2 },
      operatingMode: 'Home',
      capacityDryRun: false,
    });
    nowSpy.mockRestore();

    expect(fields.hardCapHeadroomKw).toBeCloseTo(0.8, 8);
    expect(fields.shortfallBudgetHeadroomKw).toBeCloseTo(3.4, 8);
    expect(fields.shortfallBudgetThresholdKw).toBe(8.6);
  });

  it('includes the current starved device count in periodic status', () => {
    const nowMs = Date.UTC(2025, 0, 1, 10, 30, 0);
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(nowMs);
    const fields = buildPeriodicStatusLogFields({
      capacityGuard: {
        getSoftLimit: () => 5,
        getShortfallThreshold: () => 6,
        isSheddingActive: () => false,
        isInShortfall: () => false,
      },
      powerTracker: { lastPowerW: 3000 },
      capacitySettings: { limitKw: 6, marginKw: 1 },
      operatingMode: 'Home',
      capacityDryRun: false,
      starvedDeviceCount: 2,
    });
    nowSpy.mockRestore();

    expect(fields.starvedDeviceCount).toBe(2);
  });
});
