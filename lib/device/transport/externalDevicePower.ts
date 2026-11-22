import type { DevicePowerSetupEntry, DevicePowerSetupRead } from '../../../packages/contracts/src/settingsUi/devices';
import type { HomeyDeviceLike } from '../../utils/types';
import { normalizeMeasuredPowerKw } from '../../../packages/shared-domain/src/measuredPowerObservedState';
import type { DeviceControlSettings } from '../deviceControlSettings';
import type { DeviceMeasuredPowerResolution } from '../measuredPowerResolver';
import { toCapabilityTimestampMs } from '../managerControl';
import { isHomeBatteryDevice, isSolarPanelDevice } from '../managerEnergy';
import { getDeviceAdapter } from '../deviceAdapterRegistry';
import { resolveZoneId } from './managerHelpers';
import type { TransportSnapshotStore } from './transportSnapshotStore';

type PowerSourceRead = { kind: 'device' }
  | { kind: 'external'; socketId: string; resolution: DeviceMeasuredPowerResolution };

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
  return caps.includes('onoff') || (caps.includes('target_temperature') && caps.includes('measure_temperature'));
};

const readSocketPower = (source: HomeyDeviceLike): DeviceMeasuredPowerResolution => {
  if (!source.available || source.capabilitiesObj.onoff?.value === false) return {};
  const entry = source.capabilitiesObj.measure_power;
  const watts = entry?.value;
  const observedAtMs = toCapabilityTimestampMs(entry?.lastUpdated);
  const powerKw = typeof watts === 'number' ? normalizeMeasuredPowerKw(watts / 1000) : null;
  if (powerKw === null || observedAtMs === undefined) return {};
  return {
    measuredPowerKw: powerKw, observedAtMs, source: 'external_socket',
    reading: { kind: 'instantaneous', powerKw, observedAtMs },
  };
};

const METER_SOCKET_CAPABILITIES = ['measure_power', 'onoff'] as const;

/** Owns the association between an admitted device and its metering-only socket. */
export class ExternalDevicePower {
  private readonly realtimeSocketUpdates = new Map<string, number>();

  constructor(
    private readonly settings: Pick<
      DeviceControlSettings, 'devicePowerSources' | 'managedDevices' | 'isMainFusePhaseMeter'
    > & Partial<Pick<DeviceControlSettings, 'isPowerSourceWriteCurrent'>>,
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
    if (this.settings.managedDevices[source.id] === true) return false;
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
      resolution: source && this.classifySource(target, source) ? readSocketPower(source) : {},
    };
  }

  allowsWrite(
    deviceId: string,
    device = this.inventory.getTrackedRawDevice(deviceId),
    requiresLivePower = true,
  ): boolean {
    if (this.targetForSocket(deviceId) || this.settings.isPowerSourceWriteCurrent?.(deviceId) === false) return false;
    const boundSocket = this.sourceForDevice(deviceId);
    const snapshot = this.inventory.getSnapshotByDeviceId(deviceId);
    if (snapshot && snapshot.externalPowerSocketId !== boundSocket) return false;
    if (!boundSocket) return true;
    if (!device) return false;
    const socket = this.inventory.getLastAcceptedRawDevice(boundSocket);
    if (!socket || !this.classifySource(device, socket)) return false;
    return !requiresLivePower || readSocketPower(socket).reading !== undefined;
  }

  assertAllowsWrite(deviceId: string, device: HomeyDeviceLike | undefined, requiresLivePower = true): void {
    if (this.allowsWrite(deviceId, device, requiresLivePower)) return;
    throw new Error('Device control is unavailable for the configured power source.');
  }

  readSetup(): DevicePowerSetupRead {
    const inventory = [...this.inventory.getLastAcceptedRawDevicesById().values()];
    const sockets = inventory.filter(supportsSocketPower);
    const homes = new Map(inventory.map((device) => [
      device.id, this.resolveEligibleHome(device.id, resolveZoneId(device) ?? null),
    ]));
    const resolveHome: PowerSourceHome = (id) => homes.get(id);
    const devices: DevicePowerSetupEntry[] = inventory.filter(hasGenericSetupControls).map((device) => ({
      id: device.id, name: device.name, configured: this.setupSelected(device.id),
      sourceId: this.sourceForDevice(device.id) ?? null,
      usedBy: this.targetForSocket(device.id) ?? null,
      sources: sockets.flatMap((socket) => {
        if (socket.id === device.id) return [];
        return [{ id: socket.id, name: socket.name, state: this.sourceState(device, socket, resolveHome) }];
      }),
      sourceReady: this.read(device).kind === 'device' || this.hasExternalPower(device),
    }));
    return { devices };
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

  private hasExternalPower(device: HomeyDeviceLike): boolean {
    const power = this.read(device);
    return power.kind === 'external' && power.resolution.reading !== undefined;
  }
}
