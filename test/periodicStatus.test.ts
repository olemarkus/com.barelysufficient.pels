import { buildPeriodicStatusLog } from '../periodicStatus';
import { recordPowerSample } from '../powerTracker';
import { getHourBucketKey } from '../dateUtils';
import { mockHomeyInstance } from './mocks/homey';

describe('periodic status used kWh', () => {
  it('reports usage from current hour bucket in Homey timezone', async () => {
    const state = {};
    const saveState = (nextState: any) => Object.assign(state, nextState);
    const rebuildPlanFromCache = async () => { };

    const sampleStart = Date.UTC(2025, 0, 1, 0, 30, 0);
    await recordPowerSample({
      state,
      currentPowerW: 3000,
      nowMs: sampleStart,
      homey: mockHomeyInstance as any,
      rebuildPlanFromCache,
      saveState,
      capacityGuard: undefined,
    });
    await recordPowerSample({
      state,
      currentPowerW: 3000,
      nowMs: sampleStart + 15 * 60 * 1000,
      homey: mockHomeyInstance as any,
      rebuildPlanFromCache,
      saveState,
      capacityGuard: undefined,
    });

    const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(sampleStart + 15 * 60 * 1000);
    const log = buildPeriodicStatusLog({
      capacityGuard: undefined,
      powerTracker: state,
      capacitySettings: { limitKw: 7 },
      operatingMode: 'Home',
      capacityDryRun: false,
    });
    nowSpy.mockRestore();

    expect(log).toContain('used=0.75/7.0kWh');
  });

  it('uses UTC hour bucket for usage', () => {
    const nowMs = Date.UTC(2025, 0, 1, 12, 5, 0);
    const bucketKey = getHourBucketKey(nowMs);
    expect(bucketKey).toBe('2025-01-01T12:00:00.000Z');
  });
});
