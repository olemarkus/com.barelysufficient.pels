import { isEvObserved } from '../../../packages/shared-domain/src/evObservedState';
import { isEvPlugStateConnected } from '../../../packages/shared-domain/src/evPlugState';
import type { Logger } from '../../utils/types';
import type { EvCarLinkProducer } from '../evCarLinkProducer';
import type { DeviceParseSettings } from './managerParseDevice';
import type { TransportSnapshotStore } from './transportSnapshotStore';
import type { DeviceTransportOptions } from './transportTypes';

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
    current.sessions.observeDevice(device, Date.now());
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

/** Explicit identification and continuous unmatched-connection episodes. */
export function createEvCarAssociationControl(
    probe: EvCarLinkProducer,
    settings: DeviceParseSettings,
    snapshots: TransportSnapshotStore,
    getTrigger: DeviceTransportOptions['getFlowTriggerCard'],
    logger: Logger,
) {
    const waiting = new Map<string, { sinceMs: number; elapsedMinutes: number }>();

    function hasUnmatchedConnection(chargerId: string): boolean {
        const charger = snapshots.getSnapshotByDeviceId(chargerId);
        const selected = settings.getEvCarAssociationCarIds(chargerId);
        if (!charger || !isEvObserved(charger)
            || !isEvPlugStateConnected(charger.evChargingState) || selected.length === 0) return false;
        const confirmation = probe.getCarConfirmation(chargerId);
        if (confirmation && selected.includes(confirmation.carId)) return false;
        const car = probe.getAssociatedCarForCharger(chargerId);
        return !car || !selected.includes(car.carId);
    }

    function isWaiting(chargerId: string): boolean {
        return snapshots.getSnapshotByDeviceId(chargerId)?.available === true && hasUnmatchedConnection(chargerId);
    }

    function confirm(chargerId: string, carId: string): void {
        try {
            if (!settings.getEvCarAssociationCarIds(chargerId).includes(carId)) {
                throw new Error('Select this car for the charger before confirming it.');
            }
            if (!snapshots.getSnapshotByDeviceId(chargerId)?.available) {
                throw new Error('The charger is unavailable.');
            }
            probe.confirmAssociation(chargerId, carId, Date.now());
            waiting.delete(chargerId);
        } catch (error) {
            logger.structuredLog.info({
                component: 'devices', event: 'ev_car_link_confirmation_rejected', chargerId, carId,
                reason: error instanceof Error ? error.message : String(error),
            });
            throw error;
        }
    }

    function connectionEnded(chargerId: string): boolean {
        const charger = snapshots.getSnapshotByDeviceId(chargerId);
        return charger !== undefined && (!isEvObserved(charger) || !isEvPlugStateConnected(charger.evChargingState));
    }

    /** Observation calls start/end episodes; only the heartbeat emits elapsed crossings. */
    function observe(nowMs: number): void {
        probe.retainConfirmedAssociations((chargerId, carId) =>
            snapshots.getDeviceMembership(chargerId) !== 'removed'
            && snapshots.getDeviceMembership(carId) !== 'removed'
            && !connectionEnded(chargerId)
            && settings.getEvCarAssociationCarIds(chargerId).includes(carId));
        for (const id of waiting.keys()) if (!hasUnmatchedConnection(id)) waiting.delete(id);
        for (const charger of snapshots.getSnapshot()) {
            if (isWaiting(charger.id) && !waiting.has(charger.id)) {
                waiting.set(charger.id, { sinceMs: nowMs, elapsedMinutes: 0 });
            }
        }
    }

    function tick(nowMs: number): void {
        observe(nowMs);
        for (const [chargerId, episode] of waiting) {
            if (!isWaiting(chargerId)) continue;
            const elapsedMinutes = Math.max(episode.elapsedMinutes, (nowMs - episode.sinceMs) / 60_000);
            const previousMinutes = episode.elapsedMinutes;
            waiting.set(chargerId, { sinceMs: episode.sinceMs, elapsedMinutes });
            if (Math.floor(previousMinutes) === Math.floor(elapsedMinutes) || previousMinutes >= 60) continue;
            const chargerName = snapshots.getSnapshotByDeviceId(chargerId)?.name ?? chargerId;
            void Promise.resolve().then(() => getTrigger?.('ev_car_association_waiting')?.trigger(
                { charger_name: chargerName }, { chargerId, previousMinutes, elapsedMinutes },
            )).catch((error: unknown) => logger.structuredLog.info({
                component: 'devices', event: 'ev_car_link_waiting_trigger_failed', chargerId,
                reason: error instanceof Error ? error.message : String(error),
            }));
        }
    }
    return { isWaiting, confirm, observe, tick };
}
