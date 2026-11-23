import type { DevicePowerSetupEntry, DevicePowerSetupRead } from '../../../packages/contracts/src/settingsUi/devices';
import type { HomeyDeviceLike } from '../../utils/types';
import { hasObservedMeasuredPower, normalizeMeasuredPowerKw }
  from '../../../packages/shared-domain/src/measuredPowerObservedState';
import type { DeviceControlSettings } from '../deviceControlSettings';
import { readMeasurePowerCapability } from '../measuredPowerReader';
import { toCapabilityTimestampMs } from '../managerControl';
import { isHomeBatteryDevice, isSolarPanelDevice } from '../managerEnergy';
import { getDeviceAdapter } from '../deviceAdapterRegistry';
import { resolveZoneId } from './managerHelpers';
import type { TransportDeviceSnapshot } from '../transportDeviceSnapshot';
import type { TransportSnapshotStore } from './transportSnapshotStore';
import { availableBinarySwitches, hasAcceptedBinarySwitch, supportsBinarySwitchSetup } from './binarySwitchBinding';

type PowerSourceRead = { kind: 'device' }
  | { kind: 'external'; socketId: string; capability?: HomeyDeviceLike['capabilitiesObj']['measure_power'] };

export type PowerSourceHome = (deviceId: string, zoneId: string | null) => string | undefined;

const supportsSocketPower = (device: HomeyDeviceLike): boolean => (
  device.class === 'socket' && !isHomeBatteryDevice(device) && !isSolarPanelDevice(device)
  && device.capabilities.includes('measure_power')
);

export const hasGenericSetupControls = (device: HomeyDeviceLike): boolean => {
  if (isHomeBatteryDevice(device) || isSolarPanelDevice(device)) return false;
  const integration = getDeviceAdapter(device);
  if (integration.identity(device).class === 'evcharger' || integration.nativeCurrentControls.length > 0) return false;
  // Apply only to generic controls, keeping special devices under their owners.
  const caps = device.capabilities;
  return caps.includes('onoff') || (caps.includes('target_temperature') && caps.includes('measure_temperature'))
    || availableBinarySwitches(device).length > 0
    || device.selectedBinarySwitch !== undefined;
};

function readSocketPowerCapability(source: HomeyDeviceLike): HomeyDeviceLike['capabilitiesObj']['measure_power'] {
  if (!source.available) return undefined;
  const power = source.capabilitiesObj.measure_power;
  const onoff = source.capabilitiesObj.onoff;
  if (onoff?.value !== false) return power;
  // An off report withdraws pre-switch watts. A confirmed zero measured after
  // the switch is a fresh observation in its own right.
  if (power?.value !== 0) return undefined;
  const powerAt = toCapabilityTimestampMs(power.lastUpdated);
  const offAt = toCapabilityTimestampMs(onoff.lastUpdated);
  return powerAt !== undefined && offAt !== undefined && powerAt > offAt ? power : undefined;
}

const isPowerCapability = (id: string): boolean => id === 'measure_power' || id === 'meter_power';

/** Give the normal device parser a single, selected power capability. */
export function withExternalPowerCapability(
  device: HomeyDeviceLike,
  power: PowerSourceRead | undefined,
): HomeyDeviceLike {
  if (power?.kind !== 'external') return device;
  const capabilities = device.capabilities.filter((id) => !isPowerCapability(id));
  const { measure_power: _measurePower, meter_power: _meterPower, ...capabilitiesObj } = device.capabilitiesObj;
  return {
    ...device,
    capabilities: power.capability ? [...capabilities, 'measure_power'] : capabilities,
    capabilitiesObj: power.capability ? { ...capabilitiesObj, measure_power: power.capability } : capabilitiesObj,
  };
}

/** Setup can inspect accepted inventory even for a device outside the runtime roster. */
function hasUsableDevicePower(
  device: HomeyDeviceLike, snapshot: TransportDeviceSnapshot | undefined,
): boolean {
  if (snapshot) return hasObservedMeasuredPower(snapshot);
  const reading = readMeasurePowerCapability(device.capabilities, device.capabilitiesObj);
  return reading !== undefined && normalizeMeasuredPowerKw(reading.watts / 1000) !== null;
}

/** The device's own reading, before any socket replaces it. */
function ownPowerReading(device: HomeyDeviceLike): Pick<DevicePowerSetupEntry, 'ownPowerW'> {
  const reading = readMeasurePowerCapability(device.capabilities, device.capabilitiesObj);
  if (reading === undefined || normalizeMeasuredPowerKw(reading.watts / 1000) === null) return {};
  return { ownPowerW: Math.round(reading.watts) };
}

const METER_SOCKET_CAPABILITIES = ['measure_power', 'onoff'] as const;

/** Owns the association between an admitted device and its metering-only socket. */
export class ExternalDevicePower {
  private readonly realtimeSocketUpdates = new Map<string, number>();

  constructor(
    private readonly settings: Pick<
      DeviceControlSettings, 'devicePowerSources' | 'managedDevices' | 'isMainFusePhaseMeter'
    > & Partial<Pick<DeviceControlSettings, 'isMeteringSocketReserved' | 'lastResortDevices'>>,
    private readonly inventory: TransportSnapshotStore,
    private readonly resolveHome: PowerSourceHome,
  ) {}

  targetForSocket(sourceId: string): string | undefined {
    return Object.entries(this.settings.devicePowerSources).find(([, id]) => id === sourceId)?.[0];
  }

  sourcesForTargets(deviceIds: Iterable<string>): string[] {
    return Array.from(deviceIds).flatMap((id) => {
      const socket = this.sourceForDevice(id);
      return socket ? [socket] : [];
    });
  }

  noteRealtimeSocketUpdate(socketId: string, receivedAtMs: number): void {
    if (this.targetForSocket(socketId)) this.realtimeSocketUpdates.set(socketId, receivedAtMs);
  }

  mergeSocketRefreshRead(source: HomeyDeviceLike, fetchStartedAtMs: number): HomeyDeviceLike {
    if (!this.targetForSocket(source.id)) return source;
    const accepted = this.inventory.getLastAcceptedRawDevice(source.id);
    if (!accepted) return source;
    if ((this.realtimeSocketUpdates.get(source.id) ?? 0) > fetchStartedAtMs) return accepted;
    const newer = METER_SOCKET_CAPABILITIES.flatMap((id) => {
      if (!source.capabilities.includes(id)) return [];
      const existing = accepted.capabilitiesObj[id];
      const existingAt = toCapabilityTimestampMs(existing?.lastUpdated);
      const incomingAt = toCapabilityTimestampMs(source.capabilitiesObj[id]?.lastUpdated);
      return existing && existingAt !== undefined && incomingAt !== undefined && existingAt > incomingAt
        ? [[id, existing] as const] : [];
    });
    if (newer.length === 0) return source;
    return { ...source, capabilitiesObj: { ...source.capabilitiesObj, ...Object.fromEntries(newer) } };
  }

  setupSelected(deviceId: string): boolean {
    return Object.hasOwn(this.settings.devicePowerSources, deviceId);
  }

  sourceForDevice(deviceId: string): string | undefined {
    return this.setupSelected(deviceId) ? this.settings.devicePowerSources[deviceId] ?? undefined : undefined;
  }

  private readonly resolveEligibleHome: PowerSourceHome = (id, zone) => (
    this.settings.isMainFusePhaseMeter(id) ? undefined : this.resolveHome(id, zone)
  );

  classifySource(
    target: HomeyDeviceLike,
    source: HomeyDeviceLike,
    resolveHome = this.resolveEligibleHome,
  ): boolean {
    if (source.id === target.id || !hasGenericSetupControls(target) || !supportsSocketPower(source)) return false;
    if (getDeviceAdapter(target).sourceDeviceId(target) !== target.id
      || getDeviceAdapter(source).sourceDeviceId(source) !== source.id) return false;
    if (this.settings.managedDevices[source.id] === true
      || this.inventory.externalThermostats?.loadFor(source.id) !== undefined) return false;
    const home = resolveHome(target.id, resolveZoneId(target) ?? null);
    return home !== undefined && resolveHome(source.id, resolveZoneId(source) ?? null) === home;
  }

  read(
    target: HomeyDeviceLike,
    lookup = this.inventory.getLastAcceptedRawDevice,
  ): PowerSourceRead {
    const sourceId = this.sourceForDevice(target.id);
    if (!sourceId) return { kind: 'device' };
    const source = lookup(sourceId);
    return {
      kind: 'external',
      socketId: sourceId,
      capability: source && this.classifySource(target, source) ? readSocketPowerCapability(source) : undefined,
    };
  }

  allowsWrite(deviceId: string): boolean {
    return !this.targetForSocket(deviceId) && this.settings.isMeteringSocketReserved?.(deviceId) !== true;
  }

  assertAllowsWrite(deviceId: string): void {
    if (this.allowsWrite(deviceId)) return;
    throw new Error('Device control is unavailable for the configured power source.');
  }

  readSetup(): DevicePowerSetupRead {
    const inventory = [...this.inventory.getLastAcceptedRawDevicesById().values()];
    const sockets = inventory.filter(supportsSocketPower);
    const homes = new Map(inventory.map((device) => [
      device.id, this.resolveEligibleHome(device.id, resolveZoneId(device) ?? null),
    ]));
    const resolveHome: PowerSourceHome = (id) => homes.get(id);
    const configuredSwitch = (id: string) => this.inventory.binarySwitches.settings?.getBinarySwitchSelection(id);
    const eligible = inventory.filter((device) => hasGenericSetupControls(device)
      || configuredSwitch(device.id) || this.settings.lastResortDevices?.[device.id] !== undefined
      || this.inventory.externalThermostats?.donorFor(device.id) !== undefined
      || this.inventory.externalThermostats?.loadFor(device.id) !== undefined);
    const devices: DevicePowerSetupEntry[] = eligible.map((device) => ({
      id: device.id, name: device.name, configured: this.setupSelected(device.id),
      sourceId: this.sourceForDevice(device.id) ?? null,
      lastResortMaximumW: this.settings.lastResortDevices?.[device.id],
      lastResortAvailable: this.canSetUpLastResort(device),
      defaultBinarySwitchAvailable: hasAcceptedBinarySwitch(device, 'onoff'),
      binarySwitchId: configuredSwitch(device.id) ?? null,
      binarySwitches: this.inventory.binarySwitches.settings?.getDeviceControlProfile(device.id)
        ? [] : availableBinarySwitches(device),
      usedBy: this.targetForSocket(device.id) ?? null,
      ...ownPowerReading(device),
      sources: sockets.flatMap((socket) => {
        if (socket.id === device.id) return [];
        return [{ id: socket.id, name: socket.name, state: this.sourceState(device, socket, resolveHome) }];
      }),
      sourceReady: this.isSourceReady(device),
      ...this.inventory.externalThermostats?.setup(device, inventory),
    }));
    return { devices };
  }

  private canSetUpLastResort(device: HomeyDeviceLike): boolean {
    return supportsBinarySwitchSetup(device) && !device.capabilities.includes('target_temperature')
      && this.inventory.externalThermostats?.donorFor(device.id) === undefined
      && !this.inventory.binarySwitches.settings?.getDeviceControlProfile(device.id)
      && (availableBinarySwitches(device).length > 0 || hasAcceptedBinarySwitch(device, 'onoff'))
      && !hasUsableDevicePower(device, this.inventory.getSnapshotByDeviceId(device.id));
  }

  private sourceState(
    device: HomeyDeviceLike,
    socket: HomeyDeviceLike,
    resolveHome: PowerSourceHome,
  ): DevicePowerSetupEntry['sources'][number]['state'] {
    if (this.settings.managedDevices[socket.id] === true) return 'managed';
    const assigned = this.targetForSocket(socket.id);
    if (assigned && assigned !== device.id) return 'assigned';
    return this.classifySource(device, socket, resolveHome) && !this.sourceForDevice(socket.id)
      ? 'selectable' : 'unavailable';
  }

  private isSourceReady(device: HomeyDeviceLike): boolean {
    const power = this.read(device);
    if (power.kind === 'device') return true;
    const watts = power.capability?.value;
    return typeof watts === 'number' && normalizeMeasuredPowerKw(watts / 1000) !== null;
  }
}
