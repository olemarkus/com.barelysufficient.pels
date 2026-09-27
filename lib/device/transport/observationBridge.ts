import type { TargetDeviceSnapshot } from '../../../packages/contracts/src/types';
import { projectObservedState } from '../observedStateProjection';
import { TransportObservationState } from './transportObservationState';
import type { TransportSnapshotStore } from './transportSnapshotStore';
import type {
  ObservedDeviceStateEvent,
  ObservedDeviceStateRefreshEvent,
  PlanRealtimeUpdateEvent,
} from './managerRealtimeHandlers';
import type { TemperatureAdjustmentObserver } from '../temperatureAdjustmentObserver';
import type { TransportObservedStateDispatcher } from './transportTypes';

/** Publishes transport decisions to Observer and assigns their observation order. */
export class ObservationBridge {
  readonly state = new TransportObservationState();

  constructor(
    private readonly snapshotStore: TransportSnapshotStore,
    private readonly dispatcher: TransportObservedStateDispatcher,
    private readonly temperatureAdjustments: TemperatureAdjustmentObserver,
  ) {}

  nextCursor(deviceId: string, observedAtMs?: number) {
    return this.state.nextCursor(deviceId, observedAtMs);
  }

  dispatchStateChanged(event: ObservedDeviceStateEvent): void {
    const snapshot = this.snapshotStore.getSnapshotByDeviceId(event.deviceId);
    this.dispatcher.observedStateChanged(
      snapshot ? { ...event, observed: projectObservedState(snapshot) } : event,
    );
  }

  dispatchStateForDevice(deviceId: string, capabilityId?: string): void {
    if (!this.snapshotStore.getSnapshotByDeviceId(deviceId)) return;
    this.dispatchStateChanged({
      source: 'realtime_capability',
      deviceId,
      ...this.nextCursor(deviceId),
      ...(capabilityId === undefined ? {} : { capabilityId }),
    });
  }

  dispatchStateRefresh(snapshot: readonly TargetDeviceSnapshot[]): void {
    this.temperatureAdjustments.retainDevices(new Set(snapshot.map((device) => device.id)));
    const observedAtMs = Date.now();
    const event: ObservedDeviceStateRefreshEvent = {
      entries: snapshot.map((device) => {
        const cursor = this.nextCursor(device.id, observedAtMs);
        return {
          observationSeq: cursor.observationSeq,
          observedAtMs: cursor.observedAtMs,
          observed: projectObservedState(device),
        };
      }),
    };
    this.dispatcher.observedStateRefresh(event);
  }

  dispatchControlStateChanged(event: PlanRealtimeUpdateEvent): void {
    const adjustment = this.temperatureAdjustments.observeControlChange(
      this.snapshotStore.getSnapshotByDeviceId(event.deviceId),
      event,
    );
    if (adjustment) this.dispatcher.externalTemperatureAdjusted(adjustment);
    this.dispatcher.observedControlStateChanged(event);
  }

  setGenerationW(watts: number | null, observedAtMs: number): void {
    this.dispatcher.setGenerationW(watts, observedAtMs);
  }

  emitControlStateChanged(event: PlanRealtimeUpdateEvent): void {
    const cursor = event.observationSeq === undefined || event.observedAtMs === undefined
      ? this.nextCursor(event.deviceId)
      : {};
    this.dispatchControlStateChanged({ ...event, ...cursor });
  }
}
