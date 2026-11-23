import type { DevicePowerSetupEntry } from '../../../packages/contracts/src/settingsUi/devices';
import type { TemperatureObservation } from '../../../packages/contracts/src/types';
import type { DeviceControlSettings } from '../deviceControlSettings';
import type { HomeyDeviceLike } from '../../utils/types';
import { getDeviceAdapter } from '../deviceAdapterRegistry';
import { toCapabilityTimestampMs } from '../managerControl';
import { plainDeviceAdapter } from '../standardDeviceAdapter';
import { availableBinarySwitches, hasAcceptedBinarySwitch, supportsBinarySwitchSetup } from './binarySwitchBinding';
import type { PowerSourceHome } from './externalDevicePower';
import { resolveZoneId } from './managerHelpers';
import { buildTargets } from './managerParse';
import { resolveTemperatureObservation } from './temperatureObservation';
import {
  isReportedThermostatMode, normalizeReportedThermostatMode, THERMOSTAT_MODE_CAPABILITY_ID,
} from './thermostatModeRealtime';
import type { TransportDeviceSnapshot } from '../transportDeviceSnapshot';
import type { TransportSnapshotStore } from './transportSnapshotStore';

export type ThermostatSettings = Pick<DeviceControlSettings, 'managedDevices'>
  & Partial<Pick<DeviceControlSettings, 'externalThermostats' | 'devicePowerSources'
    | 'requiresExternalThermostatManualStart'>> & {
  externalThermostatSettings?: Pick<DeviceControlSettings['externalThermostatSettings'],
    'revision' | 'isWriteCurrent' | 'isTemperatureWriteCurrent' | 'allowsBinaryWrite' | 'acceptManualStart'>;
};

type TemperatureCapability = 'measure_temperature' | 'target_temperature';
const TEMPERATURE_CAPABILITIES: readonly TemperatureCapability[] = ['measure_temperature', 'target_temperature'];

export function isThermostatTemperatureCapability(id: string): id is TemperatureCapability {
  return id === 'measure_temperature' || id === 'target_temperature';
}

type ThermostatRead = {
  donorId: string;
  temperature?: TemperatureObservation;
  measuredAtMs?: number;
  thermostatMode?: string;
};

function supportsDonor(device: HomeyDeviceLike): boolean {
  return getDeviceAdapter(device) === plainDeviceAdapter
    && device.capabilities.includes('measure_temperature')
    && device.capabilities.includes('target_temperature')
    && device.capabilitiesObj.measure_temperature?.getable !== false
    && device.capabilitiesObj.target_temperature?.getable !== false
    && device.capabilitiesObj.target_temperature?.setable === true;
}

type AcceptedBinding = { donorId: string; generation: number; key: string };
type RejectedReports = Partial<Record<TemperatureCapability, number>>;

/** Own the relationship between a load's temperature facet and its physical thermostat. */
export class ExternalThermostats {
  private readonly bindings = new Map<string, AcceptedBinding>();
  private readonly realtimeReads = new Map<string, number>();
  private readonly rejectedReports = new Map<string, RejectedReports>();
  private nextGeneration = 0;

  constructor(
    private readonly settings: ThermostatSettings,
    private readonly inventory: TransportSnapshotStore,
    private readonly resolveHome: PowerSourceHome,
  ) {}

  donorFor(loadId: string): string | undefined {
    return this.settings.externalThermostats?.[loadId];
  }

  loadFor(donorId: string): string | undefined {
    return Object.entries(this.settings.externalThermostats ?? {}).find(([, id]) => id === donorId)?.[0];
  }

  hasAssignments(): boolean {
    return Object.keys(this.settings.externalThermostats ?? {}).length > 0;
  }

  associatedDeviceIds(): string[] {
    const entries = Object.entries(this.settings.externalThermostats ?? {});
    return [...new Set(entries.flat())];
  }

  supportsLoad(load: HomeyDeviceLike): boolean {
    return supportsBinarySwitchSetup(load)
      && !load.capabilities.includes('target_temperature')
      && !this.loadFor(load.id)
      && !this.inventory.binarySwitches.settings?.getDeviceControlProfile(load.id)
      && (hasAcceptedBinarySwitch(load, 'onoff') || availableBinarySwitches(load).length > 0);
  }

  private sourceState(
    load: HomeyDeviceLike, donor: HomeyDeviceLike,
  ): DevicePowerSetupEntry['sources'][number]['state'] {
    if (this.settings.managedDevices[donor.id] === true) return 'managed';
    const loadForDonor = this.loadFor(donor.id);
    if (loadForDonor !== undefined && loadForDonor !== load.id) return 'assigned';
    if (load.id === donor.id || !this.supportsLoad(load) || !supportsDonor(donor)
        || this.donorFor(donor.id) !== undefined
        || Object.values(this.settings.devicePowerSources ?? {}).includes(donor.id)) return 'unavailable';
    const home = this.resolveHome(load.id, resolveZoneId(load) ?? null);
    return home !== undefined && this.resolveHome(donor.id, resolveZoneId(donor) ?? null) === home
      ? 'selectable' : 'unavailable';
  }

  setup(load: HomeyDeviceLike, devices: readonly HomeyDeviceLike[]): Partial<DevicePowerSetupEntry> {
    const thermostatId = this.donorFor(load.id) ?? null;
    return {
      thermostatId,
      thermostatUsedBy: this.loadFor(load.id) ?? null,
      thermostatWaitingForManualOn: this.settings.requiresExternalThermostatManualStart?.(load.id),
      thermostatReady: thermostatId === null || this.read(load)
        ?.temperature !== undefined,
      thermostats: this.supportsLoad(load) ? devices.flatMap((donor) => (
        donor.id === load.id || !supportsDonor(donor) ? [] : [this.setupDonor(load, donor)]
      )) : [],
    };
  }

  private setupDonor(
    load: HomeyDeviceLike, donor: HomeyDeviceLike,
  ): NonNullable<DevicePowerSetupEntry['thermostats']>[number] {
    const pair = this.readPair(donor).temperature;
    return {
      id: donor.id, name: donor.name, state: this.sourceState(load, donor),
      currentTemperature: pair?.currentTemperature, targetTemperature: pair?.target.value,
    };
  }

  /** Realtime temperature reports have a source date even when rejected. */
  noteReport(donorId: string, capabilityId: TemperatureCapability, value: unknown, atMs: number): void {
    this.realtimeReads.set(donorId, atMs);
    if (typeof value === 'number' && Number.isFinite(value)) {
      const rejected = this.rejectedReports.get(donorId);
      if (rejected) delete rejected[capabilityId];
      return;
    }
    this.rejectedReports.set(donorId, { ...this.rejectedReports.get(donorId), [capabilityId]: atMs });
  }

  noteDeviceUpdate(donorId: string, atMs: number): void {
    if (this.loadFor(donorId)) this.realtimeReads.set(donorId, atMs);
  }

  mergeRefreshRead(donor: HomeyDeviceLike, startedAtMs: number): HomeyDeviceLike {
    if (!this.loadFor(donor.id)) return donor;
    const prior = this.inventory.getLastAcceptedRawDevice(donor.id);
    if (!prior) return donor;
    if ((this.realtimeReads.get(donor.id) ?? 0) > startedAtMs) return prior;
    const retained = [...TEMPERATURE_CAPABILITIES, THERMOSTAT_MODE_CAPABILITY_ID].flatMap((id) => {
      const oldField = prior.capabilitiesObj[id];
      const oldAtMs = toCapabilityTimestampMs(oldField?.lastUpdated);
      const newField = donor.capabilitiesObj[id];
      const newAtMs = toCapabilityTimestampMs(newField?.lastUpdated);
      if (!donor.capabilities.includes(id) || oldAtMs === undefined || newAtMs === undefined || oldAtMs <= newAtMs) {
        return [];
      }
      return [[id, { ...newField, value: oldField?.value, lastUpdated: oldAtMs }] as const];
    });
    return retained.length === 0 ? donor : {
      ...donor, capabilitiesObj: { ...donor.capabilitiesObj, ...Object.fromEntries(retained) },
    };
  }

  private readPair(donor: HomeyDeviceLike): ThermostatRead {
    const absent = { donorId: donor.id };
    if (!donor.available) return absent;
    const measurement = this.readDatedField(donor, 'measure_temperature');
    const setpoint = this.readDatedField(donor, 'target_temperature');
    if (!measurement || !setpoint) return absent;
    const pair = resolveTemperatureObservation(measurement.value, buildTargets({
      targetCaps: ['target_temperature'],
      capabilityObj: { target_temperature: setpoint.field },
      deviceLabel: donor.name,
    }));
    if (!pair) return absent;
    return {
      donorId: donor.id,
      thermostatMode: readDonorMode(donor),
      temperature: {
        ...pair, target: { ...pair.target, temperatureBindingObservedAtMs: setpoint.atMs },
      },
      measuredAtMs: measurement.atMs,
    };
  }

  private readDatedField(donor: HomeyDeviceLike, id: TemperatureCapability) {
    const field = donor.capabilitiesObj[id];
    const atMs = toCapabilityTimestampMs(field?.lastUpdated);
    if (!field || atMs === undefined || atMs <= (this.rejectedReports.get(donor.id)?.[id] ?? -1)
        || typeof field.value !== 'number' || !Number.isFinite(field.value)) return undefined;
    return { field, atMs, value: field.value };
  }

  read(load: HomeyDeviceLike, lookup = this.inventory.getLastAcceptedRawDevice): ThermostatRead | undefined {
    const donorId = this.donorFor(load.id);
    if (donorId === undefined) return undefined;
    const donor = lookup(donorId);
    if (!load.available || !donor || this.sourceState(load, donor) !== 'selectable') return { donorId };
    return this.readPair(donor);
  }

  commitSnapshot(snapshot: TransportDeviceSnapshot): void {
    const { id, externalThermostatDonorId: donorId, temperature, thermostatMode } = snapshot;
    if (donorId === undefined || temperature === undefined) {
      this.removeBinding(id);
      return;
    }
    const key = this.bindingKey(id, donorId, temperature.target, thermostatMode);
    const previous = this.bindings.get(id);
    const generation = previous?.key === key ? previous.generation : this.nextGeneration += 1;
    if (previous?.generation !== generation) this.bindings.set(id, { donorId, generation, key });
    const target = { ...temperature.target, temperatureBindingGeneration: generation };
    Object.assign(snapshot, { temperature: { ...temperature, target }, targets: [target] });
  }

  removeBinding(loadId: string): void { this.bindings.delete(loadId); }

  private bindingKey(
    loadId: string, donorId: string, target: TemperatureObservation['target'], thermostatMode: string | undefined,
  ): string {
    return JSON.stringify([
      donorId, this.settings.externalThermostatSettings?.revision(loadId), thermostatMode,
      target.unit, target.min, target.max, target.step, target.excludeMin, target.excludeMax,
    ]);
  }

  allowsNativeTemperatureWrite(id: string): boolean {
    return this.settings.externalThermostatSettings?.isWriteCurrent(id) !== false
      && this.loadFor(id) === undefined && this.donorFor(id) === undefined;
  }

  allowsBinaryWrite(id: string, desired: boolean): boolean {
    return this.loadFor(id) === undefined
      && (this.settings.externalThermostatSettings?.allowsBinaryWrite(id, desired) ?? this.donorFor(id) === undefined);
  }

  confirmManualStart(loadId: string): void {
    if (this.settings.requiresExternalThermostatManualStart?.(loadId) !== true) return;
    const observationTime = matchingOnReportTime(
      this.inventory.getLastAcceptedRawDevice(loadId), this.inventory.getSnapshotByDeviceId(loadId),
    );
    if (observationTime !== undefined) {
      this.settings.externalThermostatSettings?.acceptManualStart(loadId, observationTime);
    }
  }

  private hasCurrentWriteAuthority(loadId: string): boolean {
    return this.settings.managedDevices[loadId] === true
      && this.settings.externalThermostatSettings?.isTemperatureWriteCurrent(loadId) !== false
      && this.settings.requiresExternalThermostatManualStart?.(loadId) !== true;
  }

  resolveWrite(loadId: string, generation: number | undefined): string | undefined {
    if (generation === undefined || !this.hasCurrentWriteAuthority(loadId)) return undefined;
    const binding = this.bindings.get(loadId);
    const load = this.inventory.getLastAcceptedRawDevice(loadId);
    if (binding?.generation !== generation || load?.available !== true
        || this.donorFor(loadId) !== binding.donorId) return undefined;
    const donor = this.inventory.getLastAcceptedRawDevice(binding.donorId);
    if (!donor || this.sourceState(load, donor) !== 'selectable') return undefined;
    const pair = this.readPair(donor);
    if (!pair.temperature) return undefined;
    const key = this.bindingKey(loadId, donor.id, pair.temperature.target, pair.thermostatMode);
    return key === binding.key ? donor.id : undefined;
  }
}

function readDonorMode(donor: HomeyDeviceLike): string | undefined {
  const field = donor.capabilitiesObj[THERMOSTAT_MODE_CAPABILITY_ID];
  if (!donor.capabilities.includes(THERMOSTAT_MODE_CAPABILITY_ID)
      || toCapabilityTimestampMs(field?.lastUpdated) === undefined
      || !isReportedThermostatMode(field?.value)) return undefined;
  return normalizeReportedThermostatMode(field.value);
}

function matchingOnReportTime(
  load: HomeyDeviceLike | undefined, snapshot: TransportDeviceSnapshot | undefined,
): number | undefined {
  const observation = snapshot?.binaryControlObservation;
  if (!load?.available || !snapshot?.available || observation?.observedValue !== true
      || snapshot.binaryControl?.on !== true) return undefined;
  if (!hasAcceptedBinarySwitch(load, observation.capabilityId, true)) return undefined;
  const observedAtMs = toCapabilityTimestampMs(load.capabilitiesObj[observation.capabilityId]?.lastUpdated);
  return observedAtMs === observation.observedAtMs ? observation.observedAtMs : undefined;
}
