import { computeShortfallThreshold } from '../lib/plan/planBudget';
import { getHourBucketKey } from '../lib/utils/dateUtils';

describe('shortfall threshold', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('uses hard cap budget, not soft margin budget', () => {
    const nowMs = Date.UTC(2025, 0, 15, 12, 0, 0);
    vi.useFakeTimers();
    vi.setSystemTime(nowMs);

    const bucketKey = getHourBucketKey(nowMs);
    const threshold = computeShortfallThreshold({
      capacitySettings: { limitKw: 10, marginKw: 2 },
      powerTracker: { buckets: { [bucketKey]: 0 } },
    });

    // At the start of the hour with no usage, threshold should match hard cap.
    expect(threshold).toBeCloseTo(10, 6);
  });

  it('tracks remaining hourly hard-cap energy budget', () => {
    const nowMs = Date.UTC(2025, 0, 15, 12, 30, 0);
    vi.useFakeTimers();
    vi.setSystemTime(nowMs);

    const bucketKey = getHourBucketKey(nowMs);
    const threshold = computeShortfallThreshold({
      capacitySettings: { limitKw: 10, marginKw: 2 },
      powerTracker: { buckets: { [bucketKey]: 4 } },
    });

    // With 4 kWh already used and 30 minutes left:
    // remaining = 10 - 4 = 6 kWh, threshold = 6 / 0.5h = 12 kW.
    expect(threshold).toBeCloseTo(12, 6);
  });
});
