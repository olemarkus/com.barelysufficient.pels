import type {
  SupportReportSection, SupportReportSubject, SupportReportValue,
} from '../../packages/contracts/src/supportReport';
import { isUnknownRecord } from '../../packages/shared-domain/src/recordGuards';
import type { HomeyDeviceLike } from '../utils/types';
import type { DeviceDiagnosticConfigurationRead } from './deviceDiagnosticConfiguration';
import { chargingInstallationGroups, resolveChargingCurrentAdapter } from '../device/chargingCurrentAdapter';
import { getDeviceAdapter, readDeviceIntegrationReportSettings } from '../device/deviceAdapterRegistry';
import { readHomeyEnergyReportSettings } from '../device/deviceReportSettings';
import { toCapabilityTimestampMs } from '../device/managerControl';

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
const TEMPERATURE_FIELDS = ['value', 'min', 'max', 'step'] as const;

const describeTemperatureTarget = (entry: Record<string, unknown>): SupportReportValue => {
  const lastUpdatedMs = toCapabilityTimestampMs(entry.lastUpdated);
  return {
    ...Object.fromEntries(TEMPERATURE_FIELDS.flatMap((field) => (
      typeof entry[field] === 'number' && Number.isFinite(entry[field]) ? [[field, entry[field]]] : []
    ))),
    ...(entry.units === '°C' || entry.units === '°F' ? { units: entry.units } : {}),
    ...(typeof entry.setable === 'boolean' ? { setable: entry.setable } : {}),
    ...(typeof entry.getable === 'boolean' ? { getable: entry.getable } : {}),
    ...(lastUpdatedMs === undefined ? {} : { lastUpdatedMs }),
  };
};

const describeCapability = (entry: unknown, id: string): SupportReportValue => {
  if (!isUnknownRecord(entry)) return null;
  if (id === 'target_temperature') return describeTemperatureTarget(entry);
  return Object.fromEntries(CAPABILITY_FIELDS.filter((field) => entry[field] !== undefined)
    .map((field) => [field, toReportValue(entry[field], 1)]));
};

const describeCapabilities = (device: HomeyDeviceLike): { [id: string]: SupportReportValue } => {
  const entries = isUnknownRecord(device.capabilitiesObj) ? device.capabilitiesObj : {};
  return Object.fromEntries(readCapabilityIds(device).map((id) => [id, describeCapability(entries[id], id)]));
};

const describeSettings = (device: HomeyDeviceLike): SupportReportValue => {
  if (device.settingsUnavailable) return { state: 'unavailable' };
  if (Object.keys(device.settings).length === 0) return { state: 'none' };
  return {
    state: 'available',
    values: {
      ...readHomeyEnergyReportSettings(device.settings),
      ...readDeviceIntegrationReportSettings(device),
    },
  };
};

const optionalText = (value: unknown): SupportReportValue => (typeof value === 'string' ? toReportValue(value) : null);

export type DeviceSupportSubject = { name: string; section: SupportReportSection };

type ProjectedHomeyInventory = {
  roster: readonly ReturnType<typeof describeRosterDevice>[];
  identities: ReadonlyMap<string, Pick<HomeyDeviceLike, 'name' | 'ownerUri'>>;
  installations: ReturnType<typeof chargingInstallationGroups>;
  supportSubject: DeviceSupportSubject | null;
  leftOut: number;
};

export type HomeyDeviceInventoryRead =
  | ({ state: 'available' } & ProjectedHomeyInventory)
  | { state: 'unavailable' };

export type CollectHomeyDeviceInventory = <T>(
  collect: (devices: AsyncIterable<HomeyDeviceLike>) => Promise<T>,
) => Promise<T>;

export const readHomeyDeviceInventory = async (
  read: CollectHomeyDeviceInventory,
  subject: SupportReportSubject,
): Promise<HomeyDeviceInventoryRead> => {
  try {
    const projected = await read((devices) => projectHomeyDeviceInventory(devices, subject));
    return { state: 'available', ...projected };
  } catch {
    return { state: 'unavailable' };
  }
};

/** Only the identifying fields needed to associate a configured meter with its integration. */
export const describeSupportReportMeter = (inventory: HomeyDeviceInventoryRead, deviceId: string) => {
  const device = inventory.state === 'available' ? inventory.identities.get(deviceId) : undefined;
  return {
    deviceId,
    ...(device ? { name: toReportValue(device.name), ownerUri: toReportValue(device.ownerUri) } : {}),
  };
};

const describeFirmware = (device: HomeyDeviceLike): SupportReportSection['values'] => {
  const firmwareVersions = getDeviceAdapter(device).firmwareVersions(device);
  return Object.keys(firmwareVersions).length === 0 ? {} : { firmwareVersions };
};

/** The selected Homey device's identity, capabilities and diagnostic settings. */
export const describeHomeyDeviceForSupport = (device: HomeyDeviceLike): SupportReportSection => ({
  title: 'Homey device',
  values: {
    id: device.id,
    class: optionalText(device.class),
    virtualClass: optionalText(device.virtualClass),
    ownerUri: device.ownerUri,
    driverId: device.driverId,
    available: device.available,
    capabilities: describeCapabilities(device),
    ...describeFirmware(device),
    deviceSettings: describeSettings(device),
    energy: toReportValue(device.energyObj ?? device.energy ?? null, 1),
  },
});

/** The most devices one report lists, far more than a home has; it says how many it left out. */
export const SUPPORT_REPORT_MAX_HOMEY_DEVICES = 500;

const describeRosterDevice = (device: HomeyDeviceLike) => ({
  id: device.id,
  name: toReportValue(device.name),
  class: device.class,
  ownerUri: device.ownerUri,
  driverId: device.driverId,
  available: device.available,
  deviceSettings: describeSettings(device),
  ...(device.capabilities.includes('target_temperature') ? {
    targetTemperature: describeCapability(device.capabilitiesObj.target_temperature, 'target_temperature'),
  } : {}),
  ...describeFirmware(device),
});

/**
 * Retain report fields as each device arrives. Meter and subject lookups and
 * installation counts include devices beyond the visible roster.
 */
async function projectHomeyDeviceInventory(
  devices: AsyncIterable<HomeyDeviceLike>, subject: SupportReportSubject,
): Promise<ProjectedHomeyInventory> {
  const roster: ReturnType<typeof describeRosterDevice>[] = [];
  const identities = new Map<string, Pick<HomeyDeviceLike, 'name' | 'ownerUri'>>();
  const installationByDeviceId = new Map<string, string>();
  let count = 0;
  let supportSubject: DeviceSupportSubject | null = null;
  for await (const device of devices) {
    count += 1;
    if (!identities.has(device.id)) identities.set(device.id, { name: device.name, ownerUri: device.ownerUri });
    const scope = resolveChargingCurrentAdapter(device)?.scope;
    if (scope?.kind === 'installation') installationByDeviceId.set(device.id, scope.installationId);
    if (subject.kind === 'device_support' && device.id === subject.deviceId && !supportSubject) {
      supportSubject = { name: device.name, section: describeHomeyDeviceForSupport(device) };
    }
    if (roster.length < SUPPORT_REPORT_MAX_HOMEY_DEVICES) {
      // eslint-disable-next-line functional/immutable-data -- the roster is local to this scan
      roster.push(describeRosterDevice(device));
    }
  }
  return {
    roster,
    identities,
    installations: chargingInstallationGroups(installationByDeviceId),
    supportSubject,
    leftOut: count - roster.length,
  };
}

/** Add PELS configuration to the projected Homey roster when capturing the report. */
export const reportHomeyDevices = (
  inventory: ProjectedHomeyInventory,
  isManaged: (deviceId: string) => boolean | undefined,
  readConfiguration: (deviceId: string) => DeviceDiagnosticConfigurationRead | undefined,
): SupportReportSection => ({
  title: 'Current Homey devices',
  values: {
    devices: inventory.roster.map((row) => {
      const managed = isManaged(row.id);
      const configuration = readConfiguration(row.id);
      const chargingInstallation = inventory.installations.get(row.id);
      return {
        ...row,
        ...(managed === undefined ? {} : { managed }),
        ...(configuration === undefined ? {} : { configuration }),
        ...(chargingInstallation === undefined ? {} : { chargingInstallation }),
      };
    }),
    leftOut: inventory.leftOut,
  },
});
