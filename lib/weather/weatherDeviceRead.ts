import type { RawHomeyDeviceLike } from '../utils/types';
import { isUnknownRecord } from '../utils/types';
import { isPlausibleOutdoorTemperature } from './weatherHistory';

/**
 * Extracts the current temperature from a raw Homey device payload. Looks up
 * the BARE `measure_temperature` capability only — weather devices (e.g. the
 * yr.no `myr` driver) also expose sub-capabilities like
 * `measure_temperature.feels_like` and `measure_temperature.min_next_6_hours`,
 * which are distinct `capabilitiesObj` keys and must not be confused with the
 * actual outdoor reading.
 *
 * Deliberately ignores the capability's `lastUpdated`: Homey only bumps it on
 * value CHANGE, so it says nothing about read validity (a flat temperature
 * plateau is still a fresh, trusted reading). Callers track their own
 * read-success time for staleness.
 */
export function readDeviceTemperature(device: RawHomeyDeviceLike): number | undefined {
  // Transport types promise an object, but a transiently missing device can
  // surface as null/undefined at runtime — fail clean, not with a TypeError.
  if (!isUnknownRecord(device)) return undefined;
  const capabilities = device.capabilitiesObj;
  if (!isUnknownRecord(capabilities)) return undefined;
  const capability = capabilities['measure_temperature'];
  if (!isUnknownRecord(capability)) return undefined;
  const value = capability.value;
  if (!isPlausibleOutdoorTemperature(value)) return undefined;
  return value;
}
