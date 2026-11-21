import { getLogger } from '../../logging/logger';
import { normalizeError } from '../../utils/errorUtils';
import { incPerfCounter } from '../../utils/perfCounters';
import { countRefreshCaller } from './refreshWorkload';
import { getCapabilities } from './managerHelpers';
import type { TransportDeviceSnapshot } from '../transportDeviceSnapshot';
import type { SnapshotRefreshOptions } from './transportTypes';
import type { TransportSnapshotStore } from './transportSnapshotStore';
import type { ObservationCursor, TransportObservationState } from './transportObservationState';
import { TARGET_TEMPERATURE_CAPABILITY_ID } from './temperatureObservation';
import type { ObservedControlStateChangedEvent } from '../../ports/observedStateEvents';

const moduleLogger = getLogger('device/transport');

type TemperatureRefresh = (options: SnapshotRefreshOptions) => Promise<unknown>;
/** Owns targeted recovery from an invalid temperature observation. */
export class TemperatureRecoveryService {
  constructor(
    private readonly state: TransportObservationState,
    private readonly snapshotStore: TransportSnapshotStore,
    private readonly refreshSnapshot: TemperatureRefresh,
    private readonly nextCursor: (deviceId: string) => ObservationCursor,
    private readonly dispatchControlStateChanged: (event: ObservedControlStateChangedEvent) => void,
  ) {}

  request(deviceId: string): void {
    // Recovery waits for the temperature facet, which needs a setpoint. A device
    // whose accepted read declares none can never complete it, so each of its
    // temperature reports would otherwise start another refresh of every device.
    // A thermostat whose setpoint reading is invalid still declares it.
    if (!this.canHoldSetpoint(deviceId)) {
      incPerfCounter('temperature_recovery_skipped_no_setpoint_total');
      return;
    }
    if (!this.state.requestTemperatureRecovery(deviceId)) return;
    countRefreshCaller('temperature_recovery');
    void this.refreshSnapshot({
      targetedRefresh: true,
      // A recovery reads devices, not homes: the per-device live lanes still
      // fill, and no meter reading is wanted back.
      meterDeviceIds: [],
    })
      .catch((error: unknown) => {
        moduleLogger.error({
          event: 'temperature_observation_recovery_failed',
          deviceId,
          err: normalizeError(error),
        });
      })
      .finally(() => this.state.finishTemperatureRecoveryRefresh(deviceId));
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
