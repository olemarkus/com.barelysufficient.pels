import { getLogger } from '../../logging/logger';
import { normalizeError } from '../../utils/errorUtils';
import { isHomeyDeviceLike } from '../../utils/types';
import type { SoleMeterAdoptionCensus } from '../../power/soleMeterAdoption';
import { resolveSoleMeterAdoptionCandidate } from '../soleCumulativeMeter';
import { DEVICES_API_PATH, getEnergyLiveReport, getRawDevices } from './managerHomeyApi';

const moduleLogger = getLogger('device/sole-meter-census');

/** At least one entry is a device record; a keyed error body or an empty payload is not a registry. */
const holdsDeviceRecords = (rawDevices: Record<string, unknown> | unknown[]): boolean => (
  (Array.isArray(rawDevices) ? rawDevices : Object.values(rawDevices)).some(isHomeyDeviceLike)
);

/**
 * The boot-time adoption's census over one LIVE energy report and one device
 * registry read, resolved at this adapter so no raw payload crosses the
 * boundary: `unavailable` covers a not-yet-initialised REST client (the
 * report answers `null` for it, and the registry is not asked), a failed
 * fetch of either half, and a registry payload holding no device record at
 * all (empty, or a keyed error body) — a home whose live report names a
 * meter has that meter as a device, so such a read is malformed or
 * transient, never evidence that no other meter exists. The census arms are
 * `resolveSoleMeterAdoptionCandidate`'s own.
 */
export async function censusSoleMeterAdoptionCandidate(): Promise<SoleMeterAdoptionCensus> {
  try {
    const report = await getEnergyLiveReport();
    if (report === null) return { state: 'unavailable' };
    const devices = await getRawDevices(DEVICES_API_PATH);
    if (!holdsDeviceRecords(devices)) return { state: 'unavailable' };
    return resolveSoleMeterAdoptionCandidate(report, devices);
  } catch (error) {
    moduleLogger.error({ event: 'sole_meter_census_read_failed', err: normalizeError(error) });
    return { state: 'unavailable' };
  }
}
