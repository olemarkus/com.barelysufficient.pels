import type { TargetDeviceSnapshot } from '../../../packages/contracts/src/types';
import type { HomeyDeviceLike, Logger } from '../../utils/types';
import type { LiveDevicePowerWatts } from '../managerEnergy';
import type { RetainedPowerPersistence } from '../retainedPowerPersistence';
import { getDebugEmitter } from '../../logging/logger';
import {
  applyDeviceDriverOverride,
  isDevicePowerCapable,
  parseDevice,
  parseDeviceList,
  type DeviceTransportParseProviders,
  type ParseDevicePurpose,
  type RetainedMeasurement,
} from './managerParseDevice';
import { resolveLatestLocalWriteMs } from './managerObservation';
import type { ResolvedTransportPowerState } from './transportTypes';
import type { TransportDeviceSnapshot } from '../transportDeviceSnapshot';
import type { ObservationBridge } from './observationBridge';
import type { TransportSnapshotStore } from './transportSnapshotStore';
import { partitionConformingDeviceReads } from './ignoredDeviceReads';
import { getDeviceId } from './managerHelpers';
import { syncNativeSteppedLoadCommandAdapters } from '../managerNativeSteppedCommand';
import { isHomeBatteryDevice } from '../managerEnergy';
import { isRuntimeTrackedDevice, resolveManagedFilterDecision } from './managerManagedFilter';
import { isHomeBatterySnapshot, toBatteryControlRead } from './homeBatteryObservation';
import type { BatteryControlRead } from '../../ports/batteryControlOwner';

const emitDeviceDebug = getDebugEmitter('devices', 'devices');

/** Parses Homey device reads and maintains the raw-device tracking indexes. */
export class DeviceSnapshotReader {
  constructor(
    readonly snapshotStore: TransportSnapshotStore,
    private readonly observationBridge: ObservationBridge,
    readonly providers: DeviceTransportParseProviders,
    readonly powerState: ResolvedTransportPowerState,
    readonly retainedPower: RetainedPowerPersistence,
    readonly logger: Logger,
  ) {}

  /** The device as the battery control owner reads it (`toBatteryControlRead`). */
  readBatteryControl(deviceId: string): BatteryControlRead {
    return toBatteryControlRead(this.snapshotStore.getSnapshotByDeviceId(deviceId));
  }

  parseDevice(
    device: HomeyDeviceLike,
    now: number,
    livePowerWByDeviceId: LiveDevicePowerWatts,
  ): TargetDeviceSnapshot | null {
    return parseDevice({
      device,
      now,
      livePowerWByDeviceId,
      previousSnapshot: this.snapshotStore.getSnapshotIndex().get(getDeviceId(device)),
      deps: this.parseDependencies(),
    });
  }

  parseDeviceList(
    list: HomeyDeviceLike[],
    livePowerWByDeviceId: LiveDevicePowerWatts = {},
    purpose: ParseDevicePurpose = 'runtime',
  ): TransportDeviceSnapshot[] {
    return parseDeviceList({
      list,
      livePowerWByDeviceId,
      previousSnapshotById: this.snapshotStore.getSnapshotIndex(),
      deps: this.parseDependencies(),
      purpose,
    });
  }

  parseConformingDeviceListForTests(list: readonly HomeyDeviceLike[]): TransportDeviceSnapshot[] {
    const { devices } = partitionConformingDeviceReads(this.snapshotStore, this.logger, list);
    this.syncTrackedDevices(devices);
    return this.parseDeviceList(devices, {}, 'unfiltered');
  }

  getUiPickerDevices(): TransportDeviceSnapshot[] {
    const rawDevices = this.snapshotStore.getLatestRawDevices();
    return rawDevices.length === 0
      ? []
      : this.parseDeviceList(rawDevices, {}, 'ui_picker');
  }

  applyDeviceDriverOverride(device: HomeyDeviceLike): HomeyDeviceLike {
    return this.providers.getDeviceDriverIdOverride
      ? applyDeviceDriverOverride(device, this.providers.getDeviceDriverIdOverride)
      : device;
  }

  /**
   * Whether realtime events for this device update the snapshot: the same
   * "tracked" answer the snapshot filter gives (`isRuntimeTrackedDevice`). A
   * device is known as a home battery here by id, from the snapshot or the raw
   * device tracking already holds; a caller with the device read in hand uses
   * {@link shouldTrackRealtimeDeviceRead}.
   */
  shouldTrackRealtimeDevice(deviceId: string): boolean {
    return this.isTracked(deviceId, this.isKnownHomeBattery(deviceId));
  }

  /** {@link shouldTrackRealtimeDevice} for a device read in hand, which names its own class. */
  shouldTrackRealtimeDeviceRead(deviceId: string, device: HomeyDeviceLike): boolean {
    return this.isTracked(deviceId, isHomeBatteryDevice(device) || this.isKnownHomeBattery(deviceId));
  }

  syncTrackedDevices(devices: HomeyDeviceLike[]): void {
    const tracked = devices.filter((device) => {
      const deviceId = getDeviceId(device);
      return deviceId !== undefined && this.isTracked(deviceId, isHomeBatteryDevice(device));
    });
    this.snapshotStore.replaceTrackedRawDevices(tracked);
    this.syncNativeSteppedLoadCommandAdapters();
  }

  syncNativeSteppedLoadCommandAdapters(): void {
    syncNativeSteppedLoadCommandAdapters({
      owner: this.snapshotStore,
      devices: [...this.snapshotStore.getTrackedRawDevicesById().values()],
      shouldTrackDevice: (deviceId) => this.shouldTrackRealtimeDevice(deviceId),
      logger: this.logger,
    });
  }

  private isTracked(deviceId: string, isHomeBattery: boolean): boolean {
    return isRuntimeTrackedDevice(
      resolveManagedFilterDecision({ providers: this.providers, deviceId }),
      isHomeBattery,
    );
  }

  private isKnownHomeBattery(deviceId: string): boolean {
    const snapshot = this.snapshotStore.getSnapshotByDeviceId(deviceId);
    if (snapshot !== undefined) return isHomeBatterySnapshot(snapshot);
    const raw = this.snapshotStore.getTrackedRawDevice(deviceId);
    return raw !== undefined && isHomeBatteryDevice(raw);
  }

  private parseDependencies() {
    return {
      logger: this.logger,
      providers: this.providers,
      debugStructured: emitDeviceDebug,
      powerState: this.powerState,
      measuredPowerResolver: this.retainedPower.resolver,
      getCapabilityObj: getCapabilityObj,
      isPowerCapable: (
        device: HomeyDeviceLike,
        capsStatus: { hasPower: boolean },
        measuredPower: { measuredPowerKw?: number },
        retainedReading: RetainedMeasurement | undefined,
      ) => isDevicePowerCapable({ device, capsStatus, measuredPower, retainedReading }),
      getRestoredPowerReading: (deviceId: string) => this.retainedPower.restoredReading(deviceId),
      resolveLatestLocalWriteMs: (deviceId: string) => resolveLatestLocalWriteMs(
        this.observationBridge.state.getObservationState(),
        deviceId,
      ),
    };
  }
}

function getCapabilityObj(device: HomeyDeviceLike) {
  return device.capabilitiesObj && typeof device.capabilitiesObj === 'object'
    ? device.capabilitiesObj as import('../managerControl').DeviceCapabilityMap
    : {};
}
