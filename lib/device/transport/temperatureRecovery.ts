import { getLogger } from '../../logging/logger';
import { normalizeError } from '../../utils/errorUtils';
import { incPerfCounter } from '../../utils/perfCounters';
import type { TransportDeviceSnapshot } from '../transportDeviceSnapshot';
import { getCapabilities } from './managerHelpers';
import type { TransportSnapshotStore } from './transportSnapshotStore';
import type { ObservationCursor, TransportObservationState } from './transportObservationState';
import { TARGET_TEMPERATURE_CAPABILITY_ID } from './temperatureObservation';
import type { ObservedControlStateChangedEvent } from '../../ports/observedStateEvents';

const moduleLogger = getLogger('device/transport');

/** Re-admit a device's facets from its accepted read, as a whole-device update would. */
type RebuildFromAcceptedRead = (deviceId: string) => void;

/**
 * Owns recovery from an invalid temperature observation.
 *
 * The temperature facet is admitted only as a complete pair, so an invalid half
 * removes it. Each half's last accepted value stays in the accepted read with
 * its own date, and every capability report updates that read first
 * (`transportServices.ts`). When a valid half returns, the facet is rebuilt from
 * the accepted read through the whole-device update path, which retires the
 * rejection and re-admits the pair at its source dates. Nothing is fetched.
 *
 * A device whose other half is still invalid stays pending: the targeted poll
 * keeps reading it, including one that left the snapshot, until the pair is
 * complete again.
 */
export class TemperatureRecoveryService {
  constructor(
    private readonly state: TransportObservationState,
    private readonly snapshotStore: TransportSnapshotStore,
    private readonly rebuildFromAcceptedRead: RebuildFromAcceptedRead,
    private readonly nextCursor: (deviceId: string) => ObservationCursor,
    private readonly dispatchControlStateChanged: (event: ObservedControlStateChangedEvent) => void,
  ) {}

  request(deviceId: string): void {
    // A device whose accepted read declares no setpoint can never hold the pair.
    // A thermostat whose setpoint reading is invalid still declares it.
    if (!this.canHoldSetpoint(deviceId)) {
      incPerfCounter('temperature_recovery_skipped_no_setpoint_total');
      return;
    }
    this.state.markTemperatureRecoveryPending(deviceId);
    incPerfCounter('temperature_recovery_rebuild_total');
    // After the report that asked for it: the rebuild replaces the snapshot
    // entry that report's handler is still holding.
    queueMicrotask(() => {
      try {
        this.rebuildFromAcceptedRead(deviceId);
        if (hasRecoveredTemperature(this.snapshotStore.getSnapshotByDeviceId(deviceId))) {
          this.state.completeTemperatureRecovery(deviceId);
        }
      } catch (error: unknown) {
        moduleLogger.error({
          event: 'temperature_observation_recovery_failed',
          deviceId,
          err: normalizeError(error),
        });
      }
    });
  }

  completeAfterRefresh(): void {
    for (const deviceId of this.state.getPendingTemperatureRecoveryDeviceIds()) {
      const recovered = this.snapshotStore.getSnapshotByDeviceId(deviceId);
      if (!hasRecoveredTemperature(recovered)) continue;
      this.state.completeTemperatureRecovery(deviceId);
      this.dispatchRecoveredTemperature(deviceId, recovered.name);
    }
  }

  private canHoldSetpoint(deviceId: string): boolean {
    const accepted = this.snapshotStore.getLastAcceptedRawDevice(deviceId);
    // No accepted read yet: nothing says the device lacks a setpoint.
    if (accepted === undefined) return true;
    return getCapabilities(accepted).includes(TARGET_TEMPERATURE_CAPABILITY_ID);
  }

  getPendingDeviceIds(): string[] {
    return this.state.getPendingTemperatureRecoveryDeviceIds();
  }

  private dispatchRecoveredTemperature(deviceId: string, deviceName: string): void {
    const cursor = this.nextCursor(deviceId);
    this.dispatchControlStateChanged({
      pelsEcho: false,
      deviceId,
      ...cursor,
      name: deviceName,
      capabilityId: TARGET_TEMPERATURE_CAPABILITY_ID,
    });
  }
}

function hasRecoveredTemperature(
  snapshot: TransportDeviceSnapshot | undefined,
): snapshot is TransportDeviceSnapshot & { temperature: NonNullable<TransportDeviceSnapshot['temperature']> } {
  return snapshot?.temperature !== undefined;
}
