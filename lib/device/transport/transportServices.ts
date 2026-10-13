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

  /** Only a complete, accepted device read may update Tesla session evidence. */
  observeChargingDevice(device: HomeyDeviceLike): void {
    const current = this.reader.chargingCurrentControl;
    current.synchronizeTrust();
    current.homeSession.observeDevice(device);
    this.synchronizeHomeChargingState();
  }

  private synchronizeHomeChargingState(): void {
    const current = this.reader.chargingCurrentControl;
    for (const snapshot of this.reader.snapshotStore.getSnapshot()) {
      if (snapshot.binaryWriteCapabilityId !== 'charging_on') continue;
      const homeAllowed = current.setup(snapshot.id).confirmation === 'vehicle'
        && current.homeSession.isAllowed(snapshot.id);
      const raw = this.reader.snapshotStore.getTrackedRawDevice(snapshot.id);
      // Home authorization can recover from companion capability events. The
      // accepted device read still owns Homey's independent availability.
      const available = homeAllowed && raw !== undefined && getIsAvailable(raw);
      const availabilityChanged = snapshot.available !== available;
      snapshot.available = available;
      if (!homeAllowed && snapshot.measuredPowerKw !== 0) {
        handleRealtimeCapabilityUpdateWithProbe(this, snapshot.id, 'measure_charge_power', 0);
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
    const session = this.reader.chargingCurrentControl.homeSession;
    this.reader.chargingCurrentControl.synchronizeTrust();
    session.observeCapability(deviceId, capabilityId, value);
    this.synchronizeHomeChargingState();
    const snapshot = this.reader.snapshotStore.getSnapshotByDeviceId(deviceId);
    const carControlled = snapshot?.binaryWriteCapabilityId === 'charging_on';
    const localValue = carControlled && capabilityId === 'measure_charge_power' && !session.isAllowed(deviceId)
      ? 0 : value;
    handleRealtimeCapabilityUpdateWithProbe(this, deviceId, capabilityId, localValue);
    const currentEvidenceChanged = [
      'measure_charge_current', 'measure_charge_current_max', 'measure_charge_power', 'charging_on', 'charging_state',
    ]
      .includes(capabilityId);
    if (carControlled && currentEvidenceChanged) {
      const current = session.confirmedCurrent(deviceId);
      if (current !== undefined) {
        handleRealtimeCapabilityUpdateWithProbe(this, deviceId, 'available_installation_current', current);
      }
    }
    if (!this.reader.snapshotStore.getSnapshotByDeviceId(deviceId)) this.deviceConfiguration.remove(deviceId);
  }
}
