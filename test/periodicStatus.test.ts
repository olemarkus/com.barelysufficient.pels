import { buildPeriodicStatusLog } from '../lib/core/periodicStatus';
import { recordPowerSample, type PowerTrackerState } from '../lib/core/powerTracker';
import { getHourBucketKey } from '../lib/utils/dateUtils';

describe('periodic status used kWh', () => {
  it('reports usage from current hour bucket in Homey timezone', async () => {
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
      capacityGuard: undefined,
    });
    await recordPowerSample({
      state,
      currentPowerW: 3000,
      nowMs: sampleStart + 15 * 60 * 1000,

      rebuildPlanFromCache,
      saveState,
      capacityGuard: undefined,
    });

    const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(sampleStart + 15 * 60 * 1000);
    const log = buildPeriodicStatusLog({
      capacityGuard: undefined,
      powerTracker: state,
      capacitySettings: { limitKw: 7, marginKw: 0.5 },
      operatingMode: 'Home',
      capacityDryRun: false,
    });
    nowSpy.mockRestore();

    expect(log).toContain('softLimit=6.50kW');
    expect(log).toContain('used=0.75kWh');
    // cap=6.5kWh, used=0.75kWh → remaining=5.75kWh
    expect(log).toContain('hourRemaining=5.8kWh');
  });

  it('uses UTC hour bucket for usage', () => {
    const nowMs = Date.UTC(2025, 0, 1, 12, 5, 0);
    const bucketKey = getHourBucketKey(nowMs);
    expect(bucketKey).toBe('2025-01-01T12:00:00.000Z');
  });

  it('labels soft limit separately from hourly usage budget', () => {
    const nowMs = Date.UTC(2025, 0, 1, 10, 55, 0);
    const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(nowMs);
    const log = buildPeriodicStatusLog({
      capacityGuard: {
        getLastTotalPower: () => 2.48,
        getSoftLimit: () => 4,
        getHeadroom: () => 1.52,
        isSheddingActive: () => false,
        isInShortfall: () => false,
      },
      powerTracker: {
        buckets: {
          [getHourBucketKey(nowMs)]: 2.52,
        },
      },
      capacitySettings: { limitKw: 5, marginKw: 1 },
      operatingMode: 'Home',
      capacityDryRun: false,
    });
    nowSpy.mockRestore();

    expect(log).toContain('softLimit=4.00kW');
    expect(log).toContain('used=2.52kWh');
    // hourCap=4.0kWh, used=2.52kWh → remaining=1.48kWh (not the full cap)
    expect(log).toContain('hourRemaining=1.5kWh');
    expect(log).not.toContain('/5.0kWh');
  });
});
