import type Homey from 'homey';
import { censusSoleMeterAdoptionCandidate } from '../lib/device/transport/soleMeterCensus';
import { SoleMeterAdoption, type SoleMeterAdoptionWriteOutcome } from '../lib/power/soleMeterAdoption';
import type { TimerRegistry } from '../lib/utils/timerRegistry';
import { savePowerSourceSelection } from './homeMeterOwnership';
import { classifySoleMeterAdoptionEligibility } from './soleMeterAdoptionEligibility';
import { readingsAdmittedSince } from './soleMeterReadingsHistory';

const adoptThroughSaveSeam = (homey: Homey.App['homey'], meterDeviceId: string): SoleMeterAdoptionWriteOutcome => {
  // The Power meter arm of the seam never consults activation (only a switch
  // TO Flow must know whether areas run), and no membership service is in
  // this caller's hands: `unavailable` is the honest boot-window value.
  let saved;
  try {
    saved = savePowerSourceSelection(
      homey,
      { op: 'set_power_source', source: 'homey_energy', meterDeviceId },
      { state: 'unavailable' },
    );
  } catch {
    // A throwing settings write is a transient. The seam writes the meter
    // first, so a throw on the source half leaves an explicit meter with no
    // source; the next attempt classifies that as `complete` and finishes it.
    return { result: 'retry', reasonCode: 'save_threw' };
  }
  if (saved.ok) return { result: 'adopted' };
  if (saved.reason === 'degraded') return { result: 'retry', reasonCode: 'save_degraded' };
  // `meter_in_use`: the sole meter belongs to a meter area, so nothing
  // nameable remains for Main — the owner's configuration, not a retry.
  return { result: 'not_applicable', reasonCode: `save_${saved.reason}` };
};

/**
 * Construct the adoption with its settings, transport, and seam collaborators,
 * and start it. `getInMemoryLastSampleMs` is the in-memory power tracker's
 * last admitted sample time, if any.
 */
export const startSoleMeterAdoption = (
  homey: Homey.App['homey'],
  timers: TimerRegistry,
  getInMemoryLastSampleMs: () => number | undefined,
): void => {
  new SoleMeterAdoption({
    classifyEligibility: () => classifySoleMeterAdoptionEligibility(homey.settings),
    census: censusSoleMeterAdoptionCandidate,
    adopt: (meterDeviceId) => adoptThroughSaveSeam(homey, meterDeviceId),
    readingsAdmittedSince: (sinceMs) => readingsAdmittedSince(homey.settings, getInMemoryLastSampleMs(), sinceMs),
    timers,
    now: () => Date.now(),
  }).start();
};
