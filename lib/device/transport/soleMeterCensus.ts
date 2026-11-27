import { getLogger } from '../../logging/logger';
import { normalizeError } from '../../utils/errorUtils';
import { parseHomeyDevicePayload } from './homeyDevicePayload';
import type { SoleMeterAdoptionCensus } from '../../power/soleMeterAdoption';
import {
  registryMeterCandidateId, resolveSoleCumulativeMeter, resolveSoleMeterAdoptionCandidate,
} from '../soleCumulativeMeter';
import { getEnergyLiveReport, readRawDeviceInventory } from './managerHomeyApi';

const moduleLogger = getLogger('device/sole-meter-census');

/** At least one entry is a device record; a keyed error body or an empty payload is not a registry. */
async function collectRegistry(entries: AsyncIterable<unknown>) {
  let hasDevice = false;
  const meters = new Set<string>();
  for await (const entry of entries) {
    hasDevice ||= parseHomeyDevicePayload(entry) !== null;
    const id = registryMeterCandidateId(entry);
    if (id !== undefined) meters.add(id);
  }
  return { hasDevice, meters };
}

/**
 * The boot-time adoption's census over one LIVE energy report and one device
 * registry read, resolved at this adapter so no raw payload crosses the
 * boundary: `unavailable` covers a not-yet-initialised REST client (the
 * report answers `null` for it, and the registry is not asked), a failed
 * fetch of either half, and a registry payload holding no device record at
 * all (empty, or a keyed error body) — a home whose live report names a
 * meter has that meter as a device, so such a read is malformed or
 * transient, never evidence that no other meter exists. The census arms are
 * `resolveSoleMeterAdoptionCandidate`'s own. The registry only corroborates
 * a sole live meter, so it is read only when the report names one: a census
 * repeated while no meter is there reads the report alone.
 */
export async function censusSoleMeterAdoptionCandidate(
  readExcluded: () => ReadonlySet<string> | null,
): Promise<SoleMeterAdoptionCensus> {
  try {
    const report = await getEnergyLiveReport();
    if (report === null) return { state: 'unavailable' };
    const excludedForReport = readExcluded();
    if (excludedForReport === null) return { state: 'unavailable' };
    const live = resolveSoleCumulativeMeter(report, excludedForReport);
    if (live.state !== 'resolved') return live;
    const { hasDevice, meters } = await readRawDeviceInventory(collectRegistry);
    if (!hasDevice) return { state: 'unavailable' };
    // Area ownership may have changed while the Homey reads were in flight.
    const excluded = readExcluded();
    if (excluded === null) return { state: 'unavailable' };
    return resolveSoleMeterAdoptionCandidate(report, meters, excluded);
  } catch (error) {
    moduleLogger.error({ event: 'sole_meter_census_read_failed', err: normalizeError(error) });
    return { state: 'unavailable' };
  }
}
