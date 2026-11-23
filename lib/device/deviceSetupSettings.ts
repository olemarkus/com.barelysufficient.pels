import type { SettingsPort } from '../ports/homeyRuntime';
import {
  DEVICE_BINARY_SWITCHES, DEVICE_EXTERNAL_THERMOSTATS, DEVICE_POWER_SOURCES, LAST_RESORT_DEVICES, MANAGED_DEVICES,
} from '../utils/settingsKeys';
import { readExternalThermostats } from '../../packages/shared-domain/src/settings/externalThermostats';
import { isAbsentSetting, readSettingsKeyList } from '../utils/settingsKeyList';
import { readDeviceBinarySwitches, type DeviceBinarySwitches }
  from '../../packages/shared-domain/src/settings/deviceBinarySwitches';

import { readDevicePowerSources, type DevicePowerSources }
  from '../../packages/shared-domain/src/settings/devicePowerSources';
export type { DevicePowerSources };
export { DeviceExternalThermostatSettings } from './externalThermostatSettings';

import { readLastResortDevices, type LastResortDevices }
  from '../../packages/shared-domain/src/settings/lastResortDevices';

export type { LastResortDevices }
  from '../../packages/shared-domain/src/settings/lastResortDevices';

type SetupSettingsPort = Pick<SettingsPort, 'get' | 'getKeys'>;
export function readDevicePowerSourcesSetting(
  settings: SetupSettingsPort, current: DevicePowerSources,
): DevicePowerSources {
  try {
    const raw = settings.get(DEVICE_POWER_SOURCES);
    const sources = readDevicePowerSources(raw);
    if (sources) return sources;
    if (isAbsentSetting(settings, DEVICE_POWER_SOURCES, raw)) return {};
  } catch { /* Keep the accepted assignments on an unreadable setting. */ }
  return current;
}

const selectionFor = (switches: DeviceBinarySwitches, deviceId: string): string | undefined => (
  Object.hasOwn(switches, deviceId) ? switches[deviceId] : undefined
);

/** Holds accepted independent switch choices and advances a revision at each change. */
export class DeviceBinarySwitchSettings {
  private accepted: DeviceBinarySwitches = {};
  private lastResort: LastResortDevices = {};
  private managed: Readonly<Record<string, boolean>> = {};
  private readonly revisions = new Map<string, number>();
  private nextRevision = 0;

  constructor(private readonly settings: SetupSettingsPort) {}

  selection(deviceId: string): string | undefined { return selectionFor(this.accepted, deviceId); }
  revision(deviceId: string): number { return this.revisions.get(deviceId) ?? 0; }

  isCurrent(deviceId: string): boolean {
    const persisted = this.read();
    if (persisted === undefined) return this.selection(deviceId) === undefined && this.lastResortIsCurrent(deviceId);
    return selectionFor(persisted, deviceId) === this.selection(deviceId)
      && this.lastResortIsCurrent(deviceId);
  }

  reload(lastResort: LastResortDevices, managed: Readonly<Record<string, boolean>>): void {
    const next = this.read() ?? this.accepted;
    const knownIds = new Set([
      ...Object.keys(this.accepted), ...Object.keys(next), ...Object.keys(this.lastResort), ...Object.keys(lastResort),
    ]);
    for (const deviceId of knownIds) {
      // A new maximum keeps the binding: transport refuses a command carrying the
      // old one, and PELS's own OFF survives the edit so the relay can resume.
      if (selectionFor(next, deviceId) === this.selection(deviceId)
        && (lastResort[deviceId] === undefined) === (this.lastResort[deviceId] === undefined)
        && (lastResort[deviceId] === undefined || managed[deviceId] === this.managed[deviceId])) continue;
      this.nextRevision += 1;
      this.revisions.set(deviceId, this.nextRevision);
    }
    this.accepted = next;
    this.lastResort = lastResort;
    this.managed = managed;
  }

  readLastResortDevices(): LastResortDevices {
    try {
      const value = this.settings.get(LAST_RESORT_DEVICES);
      const devices = readLastResortDevices(value);
      if (devices) return devices;
      const known = readSettingsKeyList(this.settings);
      if (value == null && known.status === 'resolved' && !known.keys.includes(LAST_RESORT_DEVICES)) return {};
    } catch { /* Keep the runtime's accepted setting. */ }
    return this.lastResort;
  }

  private lastResortIsCurrent(deviceId: string): boolean {
    try {
      const value = this.settings.get(LAST_RESORT_DEVICES);
      const next = readLastResortDevices(value);
      if (next) {
        const maximumW = next[deviceId];
        return maximumW === this.lastResort[deviceId]
          && (maximumW === undefined || this.readManagedDevice(deviceId) === this.managed[deviceId]);
      }
      return this.lastResort[deviceId] === undefined;
    } catch {
      return this.lastResort[deviceId] === undefined;
    }
  }

  private readManagedDevice(deviceId: string): unknown {
    const managed = this.settings.get(MANAGED_DEVICES);
    return typeof managed === 'object' && managed !== null
      ? (managed as Readonly<Record<string, unknown>>)[deviceId] : undefined;
  }

  private read(): DeviceBinarySwitches | undefined {
    try {
      const value = this.settings.get(DEVICE_BINARY_SWITCHES);
      if (value !== null && value !== undefined) return readDeviceBinarySwitches(value);
      const known = readSettingsKeyList(this.settings);
      return known.status === 'resolved' && !known.keys.includes(DEVICE_BINARY_SWITCHES) ? {} : undefined;
    } catch {
      return undefined;
    }
  }
}

type SetupMapReader = (value: unknown) => Readonly<Record<string, unknown>> | undefined;

const DEVICE_SETUP_MAPS: readonly (readonly [string, SetupMapReader])[] = [
  [DEVICE_POWER_SOURCES, readDevicePowerSources],
  [LAST_RESORT_DEVICES, readLastResortDevices],
  [DEVICE_BINARY_SWITCHES, readDeviceBinarySwitches],
  [DEVICE_EXTERNAL_THERMOSTATS, readExternalThermostats],
];

/**
 * Drop the setup entries of devices missing from Homey's full device list, so
 * a deleted or re-paired device no longer reserves its socket or thermostat.
 * An entry whose socket or thermostat is missing stays: its device still
 * shows the saved choice as unavailable. Unreadable maps are left untouched.
 */
export function pruneDeviceSetupForMissingDevices(
  settings: Pick<SettingsPort, 'get'> & Partial<Pick<SettingsPort, 'set'>>, homeyDeviceIds: ReadonlySet<string>,
): void {
  if (!settings.set) return;
  for (const [key, read] of DEVICE_SETUP_MAPS) {
    try {
      const current = read(settings.get(key));
      if (!current) continue;
      const kept = Object.entries(current).filter(([deviceId]) => homeyDeviceIds.has(deviceId));
      if (kept.length < Object.keys(current).length) settings.set?.(key, Object.fromEntries(kept));
    } catch { /* A failed read or write leaves the saved setup for the next prune. */ }
  }
}
