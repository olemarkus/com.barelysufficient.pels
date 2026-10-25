import { isEvObserved } from '../../../packages/shared-domain/src/evObservedState';
import { isEvPlugStateConnected } from '../../../packages/shared-domain/src/evPlugState';
import type { EvCarLinkEventEmitter, EvCarLinkProducer } from '../evCarLinkProducer';
import type { EvCarLinkWaitEndReason } from '../evCarLinkEvents';
import type { AssociatedCarSnapshot, CarConfirmation } from '../../../packages/contracts/src/types';
import type { CarLinkDiagnostics } from '../../ports/carLinkDiagnostics';
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
    emit: EvCarLinkEventEmitter,
) {
    const waiting = new Map<string, { sinceMs: number; elapsedMinutes: number }>();

    function chargerName(chargerId: string): string {
        return snapshots.getSnapshotByDeviceId(chargerId)?.name ?? chargerId;
    }

    /** Why `hasUnmatchedConnection` no longer holds, with the car that ended the wait. */
    function resolveWaitEnd(chargerId: string): { reason: EvCarLinkWaitEndReason; carId?: string; carName?: string } {
        const charger = snapshots.getSnapshotByDeviceId(chargerId);
        if (!charger) return { reason: 'charger_removed' };
        if (!isEvObserved(charger)) return { reason: 'plug_state_unknown' };
        if (!isEvPlugStateConnected(charger.evChargingState)) return { reason: 'unplugged' };
        const selected = settings.getEvCarAssociationCarIds(chargerId);
        if (selected.length === 0) return { reason: 'selection_cleared' };
        const confirmation = probe.getCarConfirmation(chargerId);
        if (confirmation && selected.includes(confirmation.carId)) {
            return { reason: 'confirmed', carId: confirmation.carId, carName: confirmation.carName };
        }
        // Every other way `hasUnmatchedConnection` stops holding is an associated selected car.
        const car = probe.getAssociatedCarForCharger(chargerId);
        return car ? { reason: 'linked', carId: car.carId, carName: car.carName } : { reason: 'selection_cleared' };
    }

    function startWaiting(chargerId: string, nowMs: number): void {
        waiting.set(chargerId, { sinceMs: nowMs, elapsedMinutes: 0 });
        const connection = probe.waitReports.connection(chargerId);
        emit({
            component: 'devices',
            event: 'ev_car_link_waiting_started',
            chargerId,
            chargerName: chargerName(chargerId),
            ...(connection === undefined ? {} : { connection }),
            cars: probe.waitReports.describeCars(chargerId, settings.getEvCarAssociationCarIds(chargerId)),
        });
    }

    function endWaiting(chargerId: string, nowMs: number): void {
        const episode = waiting.get(chargerId);
        if (!episode) return;
        waiting.delete(chargerId);
        emit({
            component: 'devices',
            event: 'ev_car_link_waiting_ended',
            chargerId,
            chargerName: chargerName(chargerId),
            waitedMs: Math.max(0, nowMs - episode.sinceMs),
            ...resolveWaitEnd(chargerId),
        });
    }

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
            const nowMs = Date.now();
            probe.confirmAssociation(chargerId, carId, nowMs);
            endWaiting(chargerId, nowMs);
        } catch (error) {
            emit({
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
        const ended = [...waiting.keys()].filter((id) => !hasUnmatchedConnection(id));
        for (const id of ended) endWaiting(id, nowMs);
        for (const charger of snapshots.getSnapshot()) {
            if (isWaiting(charger.id) && !waiting.has(charger.id)) startWaiting(charger.id, nowMs);
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
            void Promise.resolve().then(() => getTrigger?.('ev_car_association_waiting')?.trigger(
                { charger_name: chargerName(chargerId) }, { chargerId, previousMinutes, elapsedMinutes },
            )).catch((error: unknown) => emit({
                component: 'devices', event: 'ev_car_link_waiting_trigger_failed', chargerId,
                reason: error instanceof Error ? error.message : String(error),
            }));
        }
    }
    function diagnostics(deviceId: string, reads: CarLinkAssociationReads): CarLinkDiagnostics | undefined {
        return resolveCarLinkDiagnostics(deviceId, probe, settings, snapshots, waiting.get(deviceId)?.sinceMs, reads);
    }
    return { isWaiting, diagnostics, confirm, observe, tick };
}

/** The association and confirmation for a charger, as the transport narrows them to its selected cars. */
type CarLinkAssociationReads = {
    associatedCar: (chargerId: string) => AssociatedCarSnapshot | undefined;
    confirmedCar: (chargerId: string) => CarConfirmation | undefined;
};

/**
 * The car link as it stands for a charger or a car, for a problem report;
 * `undefined` for a device that is neither a charger nor a car the probe tracks
 * or a charger selected.
 */
function resolveCarLinkDiagnostics(
    deviceId: string,
    probe: EvCarLinkProducer,
    settings: DeviceParseSettings,
    snapshots: TransportSnapshotStore,
    waitingSinceMs: number | undefined,
    reads: CarLinkAssociationReads,
): CarLinkDiagnostics | undefined {
    if (snapshots.getSnapshotByDeviceId(deviceId)?.isEvCharger) {
        return resolveChargerCarLink(deviceId, probe, settings, waitingSinceMs, reads);
    }
    const chargerIds = snapshots.getSnapshot()
        .filter((charger) => charger.isEvCharger && settings.getEvCarAssociationCarIds(charger.id).includes(deviceId))
        .map((charger) => charger.id);
    if (chargerIds.length === 0 && !probe.getObservedCarDeviceIds().includes(deviceId)) return undefined;
    const associatedChargerId = chargerIds.find((chargerId) => reads.associatedCar(chargerId)?.carId === deviceId);
    return { role: 'car', chargerIds, ...(associatedChargerId === undefined ? {} : { associatedChargerId }) };
}

function resolveChargerCarLink(
    chargerId: string,
    probe: EvCarLinkProducer,
    settings: DeviceParseSettings,
    waitingSinceMs: number | undefined,
    reads: CarLinkAssociationReads,
): CarLinkDiagnostics {
    const connection = probe.waitReports.connection(chargerId);
    const associated = reads.associatedCar(chargerId);
    const confirmed = reads.confirmedCar(chargerId);
    const selected = settings.getEvCarAssociationCarIds(chargerId);
    return {
        role: 'charger',
        selection: selected.length > 0 ? 'selected' : 'any_car',
        cars: probe.waitReports.describeCars(
            chargerId, selected.length > 0 ? selected : probe.getObservedCarDeviceIds()),
        ...(connection === undefined ? {} : { connection }),
        ...(associated ? { associatedCar: { carId: associated.carId, carName: associated.carName } } : {}),
        ...(confirmed ? { confirmedCar: { carId: confirmed.carId, carName: confirmed.carName } } : {}),
        ...(waitingSinceMs === undefined ? {} : { waitingSinceMs }),
    };
}
