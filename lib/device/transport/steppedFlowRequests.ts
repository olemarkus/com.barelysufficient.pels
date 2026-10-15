import { randomUUID } from 'node:crypto';
import type { ChargingCurrentControl } from '../chargingCurrentControl';
import { isCanSetControl } from '../deviceActionProjection';
import type { TransportSnapshotStore } from './transportSnapshotStore';

type FlowRequest = { id: string; controlRevision: number; generation: number };

/** Opaque, per-device authority for a user Flow's immediate current action. */
export class SteppedFlowRequests {
  private readonly requests = new Map<string, FlowRequest>();

  constructor(
    private readonly snapshots: TransportSnapshotStore,
    private readonly current: ChargingCurrentControl,
  ) {}

  invalidate(deviceId: string): void { this.requests.delete(deviceId); }

  invalidateAll(): void { this.requests.clear(); }

  issue(deviceId: string): string {
    const id = randomUUID();
    this.requests.set(deviceId, { id, generation: this.current.generation,
      controlRevision: this.current.sessions.controlRevision(deviceId) });
    return id;
  }

  isValid(deviceId: string, requestId: string): boolean {
    const request = this.requests.get(deviceId);
    if (!request || request.id !== requestId || request.generation !== this.current.generation) return false;
    const snapshot = this.snapshots.getSnapshotByDeviceId(deviceId);
    const raw = this.snapshots.getTrackedRawDevice(deviceId);
    if (!snapshot || !raw || snapshot.available === false || !isCanSetControl(snapshot)) return false;
    if (this.current.setup(deviceId).method !== 'flow') return false;
    try { this.current.assertControlAllowed(raw); } catch { return false; }
    return request.controlRevision === this.current.sessions.controlRevision(deviceId);
  }
}
