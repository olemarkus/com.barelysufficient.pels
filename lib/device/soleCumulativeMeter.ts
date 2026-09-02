import { isCanonicalHomeyDeviceId } from '../utils/homeyDeviceId';
import type { SoleCumulativeMeterResolution } from '../power/soleMeterAdoption';

type UnknownRecord = Record<string, unknown>;

const asRecord = (value: unknown): UnknownRecord | null => (
  typeof value === 'object' && value !== null ? value as UnknownRecord : null
);

const toFiniteNumber = (value: unknown): number | null => (
  typeof value === 'number' && Number.isFinite(value) ? value : null
);

type CumulativeMeterRow = {
  /** `null` until the meter has published finite watts. */
  watts: number | null;
  deviceId: string | null;
};

/**
 * One cumulative row of the live report. An id-bearing row COUNTS as a meter
 * even before it has published finite watts: the report already proves that
 * meter exists, and a census that dropped it would call a two-meter home
 * "sole" for as long as the second meter warms up. A row carrying an id of
 * any shape that fails the key grammar is as unnameable as an id-less one,
 * but it exists all the same and counts. Only a row with no id at all and no
 * finite watts is nothing nameable and nothing measured — skipped.
 */
const resolveCumulativeMeterRow = (item: UnknownRecord): CumulativeMeterRow | null => {
  const watts = toFiniteNumber(asRecord(item.values)?.W);
  // Any present id — a malformed string, even a number — is a row for a meter.
  const carriesId = item.id !== undefined && item.id !== null && item.id !== '';
  // The id must satisfy the grammar every other writer of the meter key
  // enforces; an id the reader would refuse is as unnameable as no id at all.
  const deviceId = isCanonicalHomeyDeviceId(item.id) ? item.id : null;
  if (!carriesId && watts === null) return null;
  return { watts, deviceId };
};

/**
 * Repeated rows for one id are one meter; a finite reading on any of them is
 * that meter's reading, so a warming first row never hides a later one.
 */
const collectCumulativeMeterRows = (items: readonly unknown[]): CumulativeMeterRow[] => {
  const byDeviceId = new Map<string, CumulativeMeterRow>();
  const unnamed: CumulativeMeterRow[] = [];
  for (const rawItem of items) {
    const item = asRecord(rawItem);
    if (item === null || item.type !== 'cumulative') continue;
    const row = resolveCumulativeMeterRow(item);
    if (row === null) continue;
    if (row.deviceId === null) {
      unnamed.push(row);
      continue;
    }
    const seen = byDeviceId.get(row.deviceId);
    if (seen === undefined || (seen.watts === null && row.watts !== null)) byDeviceId.set(row.deviceId, row);
  }
  return [...byDeviceId.values(), ...unnamed];
};

/**
 * Does this live report carry exactly one usable cumulative meter, and does it
 * carry an id PELS can persist? Several usable candidates or a sole id-less
 * aggregate are `unresolvable` for good: there is nothing nameable, and
 * guessing is how the wrong meter's watts become the whole home's. No usable
 * candidate at all (`none_found`) is what Homey Energy looks like while
 * warming up after a reboot — an empty or malformed report, or the one meter
 * not yet publishing finite watts — so the caller treats that arm as "not
 * yet", never as an answer.
 */
export const resolveSoleCumulativeMeter = (
  liveReport: unknown,
): SoleCumulativeMeterResolution => {
  const report = asRecord(liveReport);
  if (!report || !Array.isArray(report.items)) {
    return { state: 'unresolvable', reason: 'none_found' };
  }
  const [sole, ...further] = collectCumulativeMeterRows(report.items);
  if (sole === undefined) return { state: 'unresolvable', reason: 'none_found' };
  if (further.length > 0) return { state: 'unresolvable', reason: 'ambiguous' };
  if (sole.deviceId === null) return { state: 'unresolvable', reason: 'idless_sole' };
  // The one meter, not yet publishing finite watts: not yet, not an answer.
  if (sole.watts === null) return { state: 'unresolvable', reason: 'none_found' };
  return { state: 'resolved', meterDeviceId: sole.deviceId };
};

/**
 * The meter devices the REGISTRY knows, whether or not they have published a
 * reading yet: marked cumulative (Homey's "Tracks total home energy
 * consumption") or a sensor-class device that reports power — the picker's
 * own notion of a whole-home meter. Right after a Homey reboot the live
 * report shows only what has published; a second meter whose app is still
 * starting is absent from it but present here.
 */
export const resolveRegistryMeterCandidates = (rawDevices: unknown): string[] => {
  const entries = Array.isArray(rawDevices) ? rawDevices : Object.values(asRecord(rawDevices) ?? {});
  const ids = new Set<string>();
  for (const raw of entries) {
    const device = asRecord(raw);
    if (device === null || !isCanonicalHomeyDeviceId(device.id)) continue;
    const cumulative = asRecord(device.energy)?.cumulative === true
      || asRecord(device.energyObj)?.cumulative === true;
    const capabilities: unknown[] = Array.isArray(device.capabilities) ? device.capabilities : [];
    const sensorMeter = device.class === 'sensor' && capabilities.includes('measure_power');
    if (cumulative || sensorMeter) ids.add(device.id);
  }
  return [...ids];
};

/**
 * The boot-time adoption's census: the sole cumulative meter the live report
 * names, corroborated by the registry's meter devices. The registry must
 * list the live meter as a meter AND no other meter device, published or
 * not. Another one — `ambiguous`, and the boot's run ends with nothing
 * named. A registry that does not list the live meter has not corroborated
 * anything (a partial or malformed read looks exactly like this), so that is
 * `registry_mismatch`: not an answer, tried again.
 */
export const resolveSoleMeterAdoptionCandidate = (
  liveReport: unknown,
  rawDevices: unknown,
): SoleCumulativeMeterResolution => {
  const live = resolveSoleCumulativeMeter(liveReport);
  if (live.state !== 'resolved') return live;
  const registry = resolveRegistryMeterCandidates(rawDevices);
  if (registry.some((id) => id !== live.meterDeviceId)) return { state: 'unresolvable', reason: 'ambiguous' };
  if (!registry.includes(live.meterDeviceId)) return { state: 'unresolvable', reason: 'registry_mismatch' };
  return live;
};
