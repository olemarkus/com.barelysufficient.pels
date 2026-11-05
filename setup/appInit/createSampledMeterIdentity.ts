import type { AppContext } from '../../lib/app/appContext';
import { SampledMeterIdentity } from '../../lib/power/sampledMeterIdentity';

/** Bind sample provenance to the current tracker stamp, including restored samples. */
export function createSampledMeterIdentity(ctx: AppContext): SampledMeterIdentity {
  return new SampledMeterIdentity({
    getRestoredSampleAtMs: () => ctx.powerTracker.lastTimestamp,
  });
}
