import { SampledMeterIdentity } from '../../lib/power/sampledMeterIdentity';

/** Direct service tests model a process with no restored whole-home sample. */
export const createSampledMeterIdentityWithoutRestoredSample = (): SampledMeterIdentity => (
  new SampledMeterIdentity({ getRestoredSampleAtMs: () => undefined })
);
