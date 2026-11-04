import { getDeviceAdapter } from '../deviceAdapterRegistry';
import type { ChargingCurrentControl } from '../chargingCurrentControl';
import { HomeBatteryAppActions } from '../homeBatteryAppActions';
import type { TargetDeviceSnapshot } from '../../../packages/contracts/src/types';
import type { HomeyDeviceLike, Logger } from '../../utils/types';
import type { LiveDevicePowerWatts } from '../managerEnergy';
import type { RetainedPowerPersistence } from '../retainedPowerPersistence';
import {
  applyDeviceDriverOverride,
  isDevicePowerCapable,
  parseDevice,
  type DeviceParseSources,
  type ParseDevicePurpose,
} from './managerParseDevice';
import type { ResolvedTransportPowerState } from './transportTypes';
import type { TransportDeviceSnapshot } from '../transportDeviceSnapshot';
import type { TransportSnapshotStore } from './transportSnapshotStore';
import { getDeviceId } from './managerHelpers';
import { isHomeBatteryDevice } from '../managerEnergy';
import { isRuntimeTrackedDevice, resolveManagedFilterDecision, shouldDropEarly } from './managerManagedFilter';
import { isHomeBatterySnapshot, toBatteryControlRead } from './homeBatteryObservation';
import type { BatteryControlRead } from '../../ports/batteryControlOwner';
import { DeviceManagement, type DeviceRoleMembership } from '../deviceRoleReads';
import type { DeviceTransportOptions } from './transportTypes';


/**
 * The owners every parse reads, from the ones the transport was handed and its
 * own detected roles.
 */
export function createDeviceParseSources(
  owners: Pick<DeviceTransportOptions, 'settings' | 'nativeWiring' | 'flowBacked' | 'batteryManaged'>,
  roles: DeviceRoleMembership,
  chargingCurrent: Pick<ChargingCurrentControl, 'requiresManualControl'>,
): DeviceParseSources {
  return {
    settings: owners.settings,
    nativeWiring: owners.nativeWiring,
    chargingCurrent,
    flowBacked: owners.flowBacked,
    management: new DeviceManagement(roles, owners.batteryManaged, owners.settings),
  };
}

/** Parses Homey device reads and maintains the raw-device tracking indexes. */
export class DeviceSnapshotReader {
  /**
   * The host of every battery driven through its app's Flow actions
   * (`homeBatteryAppActions.ts`), on the key owner the charging-current control
   * holds. Built here, beside the battery control read it answers; the write
   * service shares it.
   */
  readonly batteryAppActions: HomeBatteryAppActions;

  constructor(
    readonly snapshotStore: TransportSnapshotStore,
    readonly sources: DeviceParseSources,
    readonly powerState: ResolvedTransportPowerState,
    readonly retainedPower: RetainedPowerPersistence,
    readonly logger: Logger,
    readonly chargingCurrentControl: ChargingCurrentControl,
  ) {
    this.batteryAppActions = new HomeBatteryAppActions(
      chargingCurrentControl.access,
      (deviceId) => snapshotStore.getTrackedRawDevice(deviceId),
      () => snapshotStore.getLatestRawDevices(),
      logger,
    );
  }

  /**
   * The device as the battery control owner reads it (`toBatteryControlRead`);
   * a battery driven through its app's actions as their host reads it now.
   */
  readBatteryControl(deviceId: string): BatteryControlRead {
    return toBatteryControlRead(
      this.snapshotStore.getSnapshotByDeviceId(deviceId),
      (id) => this.batteryAppActions.readControl(id),
    );
  }

  parseDevice(
    read: HomeyDeviceLike,
    now: number,
    livePowerWByDeviceId: LiveDevicePowerWatts,
  ): TargetDeviceSnapshot | null {
    if (getDeviceAdapter(read).retainsPlugObservation(read)) {
      return this.retainBlockedDevice(read, 'runtime') ?? null;
    }
    const device = this.chargingCurrentControl.sessions.withholdCapabilities(read);
    const parsed = parseDevice(
      device,
      now,
      livePowerWByDeviceId,
      this.snapshotStore.getSnapshotIndex().get(getDeviceId(device)),
      this.parseDependencies(),
      'runtime',
    );
    return parsed && this.snapshotStore.nativeSteppedAdapters.projectObservation(
      this.chargingCurrentControl.projectControl(parsed), device,
    );
  }

  /**
   * A fresh read: the integration sessions observe it as of when it started (a
   * device update that arrived while it was fetched is newer than anything in
   * it), then it is parsed.
   */
  parseFetchedDeviceList(
    list: HomeyDeviceLike[],
    readAtMs: number,
    livePowerWByDeviceId: LiveDevicePowerWatts,
  ): TransportDeviceSnapshot[] {
    this.chargingCurrentControl.observeDevices(list, readAtMs);
    this.batteryAppActions.observeDevices(list, readAtMs);
    return this.parseDeviceList(list, livePowerWByDeviceId);
  }

  parseDeviceList(
    list: HomeyDeviceLike[],
    livePowerWByDeviceId: LiveDevicePowerWatts = {},
    purpose: ParseDevicePurpose = 'runtime',
  ): TransportDeviceSnapshot[] {
    const now = Date.now();
    const deps = this.parseDependencies();
    const previous = this.snapshotStore.getSnapshotIndex();
    const parsed = list.flatMap((read) => {
      if (getDeviceAdapter(read).retainsPlugObservation(read)) return [];
      const device = this.chargingCurrentControl.sessions.withholdCapabilities(read);
      const snapshot = parseDevice(device, now, livePowerWByDeviceId, previous.get(getDeviceId(device)), deps, purpose);
      return snapshot ? [this.snapshotStore.nativeSteppedAdapters.projectObservation(
        this.chargingCurrentControl.projectControl(snapshot), device,
      )] : [];
    });
    for (const device of list) {
      if (!getDeviceAdapter(device).retainsPlugObservation(device)) continue;
      const retained = this.retainBlockedDevice(device, purpose);
      if (retained) parsed.push(retained);
    }
    return parsed;
  }

  private retainBlockedDevice(
    device: HomeyDeviceLike, purpose: ParseDevicePurpose,
  ): TransportDeviceSnapshot | undefined {
    const decision = resolveManagedFilterDecision(this.sources.management, device.id);
    if (shouldDropEarly(purpose, decision, false) || (purpose === 'ui_picker' && decision.isManaged)) return undefined;
    const previous = this.snapshotStore.getSnapshotByDeviceId(device.id);
    if (!previous) return undefined;
    // Keep the last real plug observation and its source timestamp. Unknown,
    // NoPower and Calibrating must never fabricate an unplug or a new session.
    return { ...previous, managed: decision.isManaged, available: false, measuredPowerKw: 0 };
  }

  getUiPickerDevices(): TransportDeviceSnapshot[] {
    const rawDevices = this.snapshotStore.getLatestRawDevices();
    return rawDevices.length === 0
      ? []
      : this.parseDeviceList(rawDevices, {}, 'ui_picker');
  }

  applyDeviceDriverOverride(device: HomeyDeviceLike): HomeyDeviceLike {
    return applyDeviceDriverOverride(device, this.sources.settings);
  }

  /**
   * Whether realtime events for this device update the snapshot: the same
   * "tracked" answer the snapshot filter gives (`isRuntimeTrackedDevice`). A
   * device is known as a home battery here by id, from the snapshot or the raw
   * device tracking already holds; a caller with the device read in hand uses
   * {@link shouldTrackRealtimeDeviceRead}.
   */
  shouldTrackRealtimeDevice(deviceId: string): boolean {
    return this.chargingCurrentControl.sessions.observes(deviceId)
      || this.isTracked(deviceId, this.isKnownHomeBattery(deviceId));
  }

  /** {@link shouldTrackRealtimeDevice} for a device read in hand, which names its own class. */
  shouldTrackRealtimeDeviceRead(deviceId: string, device: HomeyDeviceLike): boolean {
    return this.chargingCurrentControl.sessions.observes(deviceId)
      || this.isTracked(deviceId, isHomeBatteryDevice(device) || this.isKnownHomeBattery(deviceId));
  }

  syncTrackedDevices(devices: HomeyDeviceLike[]): void {
    const tracked = devices.filter((device) => {
      const deviceId = getDeviceId(device);
      return deviceId !== undefined && (this.chargingCurrentControl.sessions.observes(deviceId)
        || this.isTracked(deviceId, isHomeBatteryDevice(device)));
    });
    this.snapshotStore.replaceTrackedRawDevices(tracked);
    this.syncNativeSteppedLoadCommandAdapters();
  }

  syncNativeSteppedLoadCommandAdapters(): void {
    this.snapshotStore.nativeSteppedAdapters.sync(
      [...this.snapshotStore.getTrackedRawDevicesById().values()],
      (deviceId) => this.shouldTrackRealtimeDevice(deviceId),
    );
  }

  private isTracked(deviceId: string, isHomeBattery: boolean): boolean {
    return isRuntimeTrackedDevice(
      resolveManagedFilterDecision(this.sources.management, deviceId),
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
      ...this.sources,
      powerState: this.powerState,
      measuredPowerResolver: this.retainedPower.resolver,
      getCapabilityObj: getCapabilityObj,
      isPowerCapable: isDevicePowerCapable,
      getRestoredPowerReading: (deviceId: string) => this.retainedPower.restoredReading(deviceId),
    };
  }
}

function getCapabilityObj(device: HomeyDeviceLike) {
  return device.capabilitiesObj && typeof device.capabilitiesObj === 'object'
    ? device.capabilitiesObj as import('../managerControl').DeviceCapabilityMap
    : {};
}
