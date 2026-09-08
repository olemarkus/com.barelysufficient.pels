import { describe, expect, it, vi } from 'vitest';
import { wirePlanStatusRealtime } from '../../setup/appInit/wireHomeRuntimeRegistry';
import { createPlanStatusRegistry } from '../../lib/plan/planStatusRegistry';
import { PLAN_STATUS_PUBLISHED_EVENT } from '../../lib/utils/settingsKeys';
import type { AppContext } from '../../lib/app/appContext';
import type { PelsStatus } from '../../lib/plan/pelsStatus';
import { PriceLevel } from '../../lib/price/priceLevels';
import { partialDouble } from '../helpers/partialDouble';

const STATUS: PelsStatus = {
  hourlyUsageKwh: 0, priceLevel: PriceLevel.UNKNOWN, devicesOn: 0, devicesOff: 0, lastPowerUpdate: 1, dryRunEffective: true,
};

// The WebView's freshness signal for a status that lives in memory: every
// publish, for every home, becomes one `plan_status_published` push carrying
// the home id — and a push the SDK rejects is reported, never thrown at the
// publishing plan service.
describe('wirePlanStatusRealtime', () => {
  const rig = (realtime: ReturnType<typeof vi.fn>) => {
    const planStatuses = createPlanStatusRegistry();
    const error = vi.fn();
    const ctx = partialDouble<AppContext>({
      planStatuses,
      error,
      homey: { api: { realtime } } as never,
    });
    wirePlanStatusRealtime(ctx);
    return { planStatuses, error };
  };

  it('pushes the home id of every publish', () => {
    const realtime = vi.fn().mockResolvedValue(undefined);
    const { planStatuses } = rig(realtime);
    planStatuses.publish('main', STATUS);
    planStatuses.publish('h_area', STATUS);
    expect(realtime.mock.calls).toEqual([
      [PLAN_STATUS_PUBLISHED_EVENT, { homeId: 'main' }],
      [PLAN_STATUS_PUBLISHED_EVENT, { homeId: 'h_area' }],
    ]);
  });

  it('reports a rejected push through the app error channel', async () => {
    const realtime = vi.fn().mockRejectedValue(new Error('bridge down'));
    const { planStatuses, error } = rig(realtime);
    planStatuses.publish('main', STATUS);
    await new Promise((resolve) => { setTimeout(resolve, 0); });
    expect(error).toHaveBeenCalledWith('Failed to emit plan_status_published event', expect.any(Error));
  });
});
