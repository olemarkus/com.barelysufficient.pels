import type { TemperatureRecoveryService } from './temperatureRecovery';
import type { BinarySettleEvidenceService } from './binarySettleEvidence';
import type { ObservationBridge } from './observationBridge';
import type { ObservationProducers } from '../observationProducers';
import type { DeviceSnapshotReader } from './deviceSnapshotReader';
import type { TransportNotifications } from './transportNotifications';
import type { DeviceConfigurationStore } from '../deviceConfiguration';
import type { HomeyDeviceLike } from '../../utils/types';
import { handleRealtimeDeviceUpdateEvent } from './deviceUpdateHandling';
import { handleRealtimeCapabilityUpdateWithProbe } from './realtimeCapabilityHandling';
import { getIsAvailable } from './managerHelpers';

/** Realtime ingestion collaborators. Refresh lifecycle state and SDK lifecycle are absent. */
export class RealtimeIngestService {
  constructor(
    readonly binaryEvidence: BinarySettleEvidenceService,
    readonly observationBridge: ObservationBridge,
    readonly observationProducers: ObservationProducers,
    readonly temperatureRecovery: TemperatureRecoveryService,
    readonly reader: DeviceSnapshotReader,
    readonly notifications: TransportNotifications,
    private readonly deviceConfiguration: DeviceConfigurationStore,
  ) {}

  handleDeviceUpdate(device: HomeyDeviceLike): void {
    handleRealtimeDeviceUpdateEvent(this, device);
  }

  /** Only a complete, accepted device read may update integration session evidence. */
  observeChargingDevice(device: HomeyDeviceLike): void {
    const current = this.reader.chargingCurrentControl;
    current.synchronizeTrust();
    current.sessions.observeDevice(device);
    this.synchronizeAdapterState();
  }

  private synchronizeAdapterState(): void {
    const current = this.reader.chargingCurrentControl;
    for (const snapshot of this.reader.snapshotStore.getSnapshot()) {
      if (!current.sessions.controls(snapshot)) continue;
      const raw = this.reader.snapshotStore.getTrackedRawDevice(snapshot.id);
      // Home authorization can recover from companion capability events. The
      // accepted device read still owns Homey's independent availability.
      const previousAvailability = snapshot.available;
      snapshot.available = raw !== undefined && getIsAvailable(raw);
      const resolved = current.projectControl(snapshot);
      const available = resolved.available;
      const availabilityChanged = previousAvailability !== available;
      snapshot.available = available;
      const powerKw = resolved.measuredPowerKw;
      if (powerKw !== undefined && powerKw !== snapshot.measuredPowerKw) {
        handleRealtimeCapabilityUpdateWithProbe(this, snapshot.id, 'measure_power', powerKw * 1000);
      }
      this.deviceConfiguration.set(snapshot);
      if (availabilityChanged) this.observationBridge.dispatchStateForDevice(snapshot.id);
    }
  }

  /** Publish the same accepted snapshot before its observation reaches consumers. */
  publishDeviceConfiguration(deviceId: string): void {
    const snapshot = this.reader.snapshotStore.getSnapshotByDeviceId(deviceId);
    if (snapshot) this.deviceConfiguration.set(snapshot);
    else this.deviceConfiguration.remove(deviceId);
  }

  handleCapabilityUpdate(deviceId: string, capabilityId: string, value: unknown): void {
    const session = this.reader.chargingCurrentControl.sessions;
    this.reader.chargingCurrentControl.synchronizeTrust();
    session.observeCapability(deviceId, capabilityId, value);
    this.synchronizeAdapterState();
    const snapshot = this.reader.snapshotStore.getSnapshotByDeviceId(deviceId);
    if (snapshot) {
      for (const event of this.reader.chargingCurrentControl.sessions.controlEvents(snapshot, capabilityId, value)) {
        handleRealtimeCapabilityUpdateWithProbe(this, deviceId, event.capabilityId, event.value);
      }
    } else {
      handleRealtimeCapabilityUpdateWithProbe(this, deviceId, capabilityId, value);
    }
    if (!this.reader.snapshotStore.getSnapshotByDeviceId(deviceId)) this.deviceConfiguration.remove(deviceId);
  }
}
