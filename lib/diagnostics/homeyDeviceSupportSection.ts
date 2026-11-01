import type { SupportReportSection, SupportReportValue } from '../../packages/contracts/src/supportReport';
import { isUnknownRecord } from '../../packages/shared-domain/src/recordGuards';
import type { HomeyDeviceLike } from '../utils/types';

const readCapabilityIds = (device: HomeyDeviceLike): string[] => (
  Array.isArray(device.capabilities)
    ? device.capabilities.filter((capability): capability is string => typeof capability === 'string')
    : []
);

const MAX_TEXT_LENGTH = 200;
const MAX_DEPTH = 4;
const MAX_ENTRIES = 50;

/**
 * An untrusted Homey value as a report can carry it: finite numbers, strings
 * cut to a readable length, and nesting and collections bounded, so one
 * vendor's large payload cannot crowd the rest of the report out.
 */
const toReportValue = (value: unknown, depth = 0): SupportReportValue => {
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') return value.length > MAX_TEXT_LENGTH ? `${value.slice(0, MAX_TEXT_LENGTH)}…` : value;
  if (depth >= MAX_DEPTH) return null;
  if (Array.isArray(value)) return value.slice(0, MAX_ENTRIES).map((entry) => toReportValue(entry, depth + 1));
  if (!isUnknownRecord(value)) return null;
  return Object.fromEntries(Object.entries(value).slice(0, MAX_ENTRIES)
    .map(([key, entry]) => [key, toReportValue(entry, depth + 1)]));
};

// What a capability's entry says about how PELS could read and drive it.
const CAPABILITY_FIELDS = ['value', 'units', 'setable', 'getable', 'min', 'max', 'step', 'values'] as const;

const describeCapabilities = (device: HomeyDeviceLike): { [id: string]: SupportReportValue } => {
  const entries = isUnknownRecord(device.capabilitiesObj) ? device.capabilitiesObj : {};
  return Object.fromEntries(readCapabilityIds(device).map((id) => {
    const entry: unknown = entries[id];
    if (!isUnknownRecord(entry)) return [id, null];
    return [id, Object.fromEntries(CAPABILITY_FIELDS
      .filter((field) => entry[field] !== undefined)
      .map((field) => [field, toReportValue(entry[field], 1)]))];
  }));
};

// The settings that say how much power the device uses when Homey has no reading.
const ENERGY_SETTINGS = ['load', 'energy_value_on', 'energy_value_off'] as const;

const describeEnergySettings = (device: HomeyDeviceLike): { [key: string]: SupportReportValue } => {
  const settings = isUnknownRecord(device.settings) ? device.settings : {};
  return Object.fromEntries(ENERGY_SETTINGS
    .filter((key) => settings[key] !== undefined)
    .map((key) => [key, toReportValue(settings[key], 1)]));
};

const optionalText = (value: unknown): SupportReportValue => (typeof value === 'string' ? toReportValue(value) : null);

/** A device support request's account of one device: its name and what Homey reports about it. */
export type HomeyDeviceSupportDescription = { name: string; section: SupportReportSection };

/**
 * What a device support request carries about a device PELS does not list:
 * what Homey says the device is, which app provides it, and every capability
 * with its current value and range. That is what deciding support needs.
 */
export const describeHomeyDeviceForSupport = (device: HomeyDeviceLike): SupportReportSection => ({
  title: 'Homey device',
  values: {
    id: device.id,
    class: optionalText(device.class),
    virtualClass: optionalText(device.virtualClass),
    ownerUri: optionalText(device.ownerUri ?? device.driver?.owner_uri),
    driverUri: optionalText(device.driverUri ?? device.driver?.uri),
    driverId: optionalText(device.driverId ?? device.driver?.id),
    available: typeof device.available === 'boolean' ? device.available : null,
    capabilities: describeCapabilities(device),
    energySettings: describeEnergySettings(device),
    energy: toReportValue(device.energyObj ?? device.energy ?? null, 1),
  },
});

/**
 * One Homey device as a device support request describes it, listed by PELS
 * or not; `undefined` when Homey has no such device. A failed read rejects.
 */
export async function readHomeyDeviceForSupport(
  readDevices: () => Promise<HomeyDeviceLike[]>,
  deviceId: string,
): Promise<HomeyDeviceSupportDescription | undefined> {
  const device = (await readDevices()).find((entry) => entry.id === deviceId);
  return device ? { name: device.name, section: describeHomeyDeviceForSupport(device) } : undefined;
}
