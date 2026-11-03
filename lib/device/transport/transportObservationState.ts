/**
 * Owns the transport's transient observation bookkeeping. Callers decide when
 * to refresh and emit; this state only records facts, ordering, and recovery
 * work that is still pending.
 */
import type { BinaryControlObservation } from '../../../packages/contracts/src/types';
import { createObservationState, type DeviceTransportObservationState } from './observationState';
import { OwnCapabilityWrites } from './ownCapabilityWrites';
import { cloneBinaryControlObservation } from './transportTypes';

/**
 * Non-optional per-device observation cursor. `nextCursor` always resolves both
 * fields; this type makes that an enforced invariant rather than an `as number`
 * assertion at the refresh-dispatch site.
 */
export type ObservationCursor = { observationSeq: number; observedAtMs: number };

const DUPLICATE_EVENT_PRUNE_AFTER_MS = 10 * 60 * 1_000;

export class TransportObservationState {
  private readonly observations = createObservationState();
  /** PELS's writes awaiting Homey's echo (`ownCapabilityWrites.ts`). */
  readonly ownWrites = new OwnCapabilityWrites();
  private readonly observationSeqByDeviceId = new Map<string, number>();
  private readonly realtimeCapabilityEventTimesByKey = new Map<string, number>();
  private readonly binarySettleEvidenceByDeviceId = new Map<string, BinaryControlObservation>();
  private readonly pendingTemperatureRecoveryDeviceIds = new Set<string>();
  private readonly temperatureRecoveryRefreshInFlightDeviceIds = new Set<string>();

  getObservationState(): DeviceTransportObservationState {
    return this.observations;
  }

  nextCursor(deviceId: string, observedAtMs: number = Date.now()): ObservationCursor {
    const observationSeq = (this.observationSeqByDeviceId.get(deviceId) ?? 0) + 1;
    this.observationSeqByDeviceId.set(deviceId, observationSeq);
    return { observationSeq, observedAtMs };
  }

  shouldEmitRealtimeCapabilityEvent(key: string, nowMs: number, windowMs: number): boolean {
    this.pruneDuplicateRealtimeCapabilityEvents(nowMs);
    const previousAtMs = this.realtimeCapabilityEventTimesByKey.get(key);
    if (previousAtMs !== undefined && nowMs - previousAtMs < windowMs) return false;
    this.realtimeCapabilityEventTimesByKey.set(key, nowMs);
    return true;
  }

  getBinarySettleEvidence(deviceId: string): BinaryControlObservation | undefined {
    const evidence = this.binarySettleEvidenceByDeviceId.get(deviceId);
    return evidence === undefined ? undefined : cloneBinaryControlObservation(evidence);
  }

  upsertBinarySettleEvidence(deviceId: string, evidence: BinaryControlObservation): BinaryControlObservation {
    const existing = this.binarySettleEvidenceByDeviceId.get(deviceId);
    if (existing !== undefined && existing.observedAtMs > evidence.observedAtMs) {
      return cloneBinaryControlObservation(existing);
    }
    const accepted = cloneBinaryControlObservation(evidence);
    this.binarySettleEvidenceByDeviceId.set(deviceId, accepted);
    return cloneBinaryControlObservation(accepted);
  }

  clearBinarySettleEvidence(deviceId: string): boolean {
    return this.binarySettleEvidenceByDeviceId.delete(deviceId);
  }

  retainBinarySettleEvidenceFor(deviceIds: ReadonlySet<string>): void {
    for (const deviceId of this.binarySettleEvidenceByDeviceId.keys()) {
      if (!deviceIds.has(deviceId)) this.binarySettleEvidenceByDeviceId.delete(deviceId);
    }
  }

  requestTemperatureRecovery(deviceId: string): boolean {
    this.pendingTemperatureRecoveryDeviceIds.add(deviceId);
    if (this.temperatureRecoveryRefreshInFlightDeviceIds.has(deviceId)) return false;
    this.temperatureRecoveryRefreshInFlightDeviceIds.add(deviceId);
    return true;
  }

  finishTemperatureRecoveryRefresh(deviceId: string): void {
    this.temperatureRecoveryRefreshInFlightDeviceIds.delete(deviceId);
  }

  getPendingTemperatureRecoveryDeviceIds(): string[] {
    return [...this.pendingTemperatureRecoveryDeviceIds];
  }

  completeTemperatureRecovery(deviceId: string): boolean {
    return this.pendingTemperatureRecoveryDeviceIds.delete(deviceId);
  }

  clear(): void {
    this.observations.debugObservedSourcesByDeviceId.clear();
    this.observations.capabilityObservations.clear();
    this.observationSeqByDeviceId.clear();
    this.ownWrites.clear();
    this.realtimeCapabilityEventTimesByKey.clear();
    this.binarySettleEvidenceByDeviceId.clear();
    this.pendingTemperatureRecoveryDeviceIds.clear();
    this.temperatureRecoveryRefreshInFlightDeviceIds.clear();
  }

  private pruneDuplicateRealtimeCapabilityEvents(nowMs: number): void {
    for (const [key, emittedAtMs] of this.realtimeCapabilityEventTimesByKey) {
      if (nowMs - emittedAtMs > DUPLICATE_EVENT_PRUNE_AFTER_MS) {
        this.realtimeCapabilityEventTimesByKey.delete(key);
      }
    }
  }
}
