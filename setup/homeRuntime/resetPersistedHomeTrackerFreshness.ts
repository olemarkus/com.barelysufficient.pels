import type { AppContext } from '../../lib/app/appContext';
import type { PowerTrackerMeterIdentity } from '../../lib/power/trackerTypes';
import { resetPersistedHomeTrackerFreshnessInSettings } from '../../lib/power/persistedHomeTracker';
import { normalizeError } from '../../lib/utils/errorUtils';
import type { HomeId } from '../../lib/utils/settingsKeys';

/**
 * Clear a dormant sub-home meter's freshness identity before its runtime is
 * activated. Accounting buckets remain intact; only the last meter sample
 * latch is removed. Both boundary reads and writes are contained so the
 * registry can retain the pending activation and retry it.
 */
export function resetPersistedHomeTrackerFreshness(params: {
  ctx: AppContext;
  homeId: HomeId;
  meterIdentity?: PowerTrackerMeterIdentity;
}): boolean {
  const { ctx, homeId, meterIdentity } = params;
  return resetPersistedHomeTrackerFreshnessInSettings({
    settings: ctx.homey.settings,
    homeId,
    meterIdentity,
    onFailure: (error) => {
      ctx.getStructuredLogger('homes')?.error({
        event: 'home_dormant_tracker_freshness_reset_failed',
        homeId,
        err: normalizeError(error),
      });
    },
  });
}
