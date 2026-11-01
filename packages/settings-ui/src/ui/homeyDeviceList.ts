import type { HomeyDeviceListEntry } from '../../../contracts/src/settingsUi/homeyDevices.ts';
import { isUnknownRecord } from '../../../shared-domain/src/recordGuards.ts';
import { callApi } from './homey.ts';

/**
 * Every device on the Homey, PELS-listed or not, from `/homey_devices`. The
 * answer crosses the Homey API bridge, so it is validated once here: an entry
 * without an id and a name is dropped, and every other field falls back to
 * what it means when absent.
 */
const parseEntry = (value: unknown): HomeyDeviceListEntry | null => {
  if (!isUnknownRecord(value) || typeof value.id !== 'string' || !value.id || typeof value.name !== 'string') {
    return null;
  }
  return {
    id: value.id,
    name: value.name,
    ...(typeof value.class === 'string' && value.class ? { class: value.class } : {}),
    zoneName: typeof value.zoneName === 'string' && value.zoneName ? value.zoneName : null,
    hasTemperature: value.hasTemperature === true,
    hasPower: value.hasPower === true,
  };
};

export const parseHomeyDeviceList = (value: unknown): HomeyDeviceListEntry[] => (
  Array.isArray(value) ? value.flatMap((entry) => parseEntry(entry) ?? []) : []
);

let latest: readonly HomeyDeviceListEntry[] | null = null;

/**
 * Reads the list from Homey and keeps it for `findHomeyDeviceName`. The route
 * answers an empty list when Homey cannot be read.
 */
export const loadHomeyDeviceList = async (): Promise<readonly HomeyDeviceListEntry[]> => {
  const devices = parseHomeyDeviceList(await callApi<unknown>('GET', '/homey_devices'));
  latest = devices;
  return devices;
};

/** The device's name from the last list read; `null` before a read or for a device it did not hold. */
export const findHomeyDeviceName = (deviceId: string): string | null => (
  latest?.find((device) => device.id === deviceId)?.name ?? null
);
