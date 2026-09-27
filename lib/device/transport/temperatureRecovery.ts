import { getLogger } from '../../logging/logger';
import { normalizeError } from '../../utils/errorUtils';
import type { TransportDeviceSnapshot } from '../transportDeviceSnapshot';
import type { SnapshotRefreshOptions } from './transportTypes';
import type { TransportSnapshotStore } from './transportSnapshotStore';
import type { TransportObservationState, TransportObservationCursor } from './transportObservationState';
import type { PlanRealtimeUpdateEvent } from './managerRealtimeHandlers';
import type { DeviceTransportParseProviders } from './managerParseDevice';
import { TARGET_TEMPERATURE_CAPABILITY_ID } from './temperatureObservation';

const moduleLogger = getLogger('device/transport');

type TemperatureRefresh = (options: SnapshotRefreshOptions) => Promise<unknown>;
/** Owns targeted recovery from an invalid temperature observation. */
export class TemperatureRecoveryService {
  constructor(
    private readonly state: TransportObservationState,
    private readonly snapshotStore: TransportSnapshotStore,
    private readonly refreshSnapshot: TemperatureRefresh,
    private readonly providers: DeviceTransportParseProviders,
    private readonly nextCursor: (deviceId: string) => TransportObservationCursor,
    private readonly dispatchControlStateChanged: (event: PlanRealtimeUpdateEvent) => void,
  ) {}

  request(deviceId: string): void {
    if (!this.state.requestTemperatureRecovery(deviceId)) return;
    void this.refreshSnapshot({
      targetedRefresh: true,
      mainMeterSelection: this.providers.getHomeyEnergyMeterSelection(),
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

  getPendingDeviceIds(): string[] {
    return this.state.getPendingTemperatureRecoveryDeviceIds();
  }

  private dispatchRecoveredTemperature(deviceId: string, deviceName: string): void {
    const cursor = this.nextCursor(deviceId);
    this.dispatchControlStateChanged({
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
