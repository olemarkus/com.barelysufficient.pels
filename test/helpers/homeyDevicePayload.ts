/**
 * Device payloads in the shape Homey's device list reports them.
 *
 * A raw payload restates every capability's id inside its own entry and dates
 * every value. These builders write each capability once, as a reading, and
 * date the readings with one stamp. A reading that needs its own stamp, units
 * or other entry fields carries them, and they win over the shared stamp.
 */
import type { CapabilityValue, HomeyDeviceLike } from '../../lib/utils/types';

/** When Homey observed a value: an entry's `lastUpdated`. */
type ReadingStamp = CapabilityValue<unknown>['lastUpdated'];

/** A capability entry without the id, which the reading's key supplies. */
type ReadingSpec = Omit<CapabilityValue<unknown>, 'id' | 'value'> & { value: unknown };

/** A bare value is a reading that carries nothing else. */
type CapabilityReading = string | number | boolean | null | undefined | ReadingSpec;

type CapabilitiesObj = NonNullable<HomeyDeviceLike['capabilitiesObj']>;

/** A temperature reading in degrees Celsius. */
export const celsius = (value: unknown): ReadingSpec => ({ value, units: '°C' });

/** A reading of a capability PELS may write. */
export const setable = (value: unknown): ReadingSpec => ({ value, setable: true });

/**
 * The `capabilitiesObj` for `readings`, in their order. Every entry carries its
 * id, and is dated `at` unless the reading has its own `lastUpdated`. Without
 * `at`, an entry has no `lastUpdated` unless its reading gives one.
 */
export const capabilityReadings = <K extends string>(
  readings: Record<K, CapabilityReading>,
  at?: ReadingStamp,
): CapabilitiesObj & Record<K, CapabilityValue<unknown>> => (
  Object.fromEntries(Object.entries<CapabilityReading>(readings).map(([id, reading]) => {
    const spec = typeof reading === 'object' && reading !== null ? reading : { value: reading };
    return [id, { id, ...(at === undefined ? {} : { lastUpdated: at }), ...spec }];
  })) as CapabilitiesObj & Record<K, CapabilityValue<unknown>>
);

/**
 * A device payload: `device` plus its readings. The capability list follows
 * the readings' order unless `device` names its own.
 */
export const homeyDevice = <K extends string>(
  device: Omit<HomeyDeviceLike, 'capabilitiesObj'>,
  readings: Record<K, CapabilityReading>,
  at?: ReadingStamp,
): HomeyDeviceLike & {
  capabilities: string[];
  capabilitiesObj: CapabilitiesObj & Record<K, CapabilityValue<unknown>>;
} => ({
  capabilities: Object.keys(readings),
  ...device,
  capabilitiesObj: capabilityReadings(readings, at),
});
