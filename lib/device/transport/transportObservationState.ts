/**
 * Owns the transport's transient observation bookkeeping. Callers decide when
 * to refresh and emit; this state only records facts, ordering, and recovery
 * work that is still pending.
 */
import type { BinaryControlObservation } from '../../../packages/contracts/src/types';
import { createObservationState, type DeviceTransportObservationState } from './observationState';
import { OwnCapabilityWrites, type OwnCapabilityWrite } from './ownCapabilityWrites';
import type { TransportDeviceSnapshot } from '../transportDeviceSnapshot';
import { cloneBinaryControlObservation } from './transportTypes';

/**
 * Non-optional per-device observation cursor. `nextCursor` always resolves both
 * fields; this type makes that an enforced invariant rather than an `as number`
 * assertion at the refresh-dispatch site.
 */
export type ObservationCursor = { observationSeq: number; observedAtMs: number };

const DUPLICATE_EVENT_PRUNE_AFTER_MS = 10 * 60 * 1_000;

/**
 * What PELS commanded since the last device read: the views its capability
 * writes named, or `every_device` once a command ran through a Flow card or a
 * battery app's actions, whose devices no write names.
 */
export type WrittenSinceRead =
  | { kind: 'every_device' }
  | { kind: 'devices'; ids: readonly string[] };

export class TransportObservationState {
  private readonly observations = createObservationState();
  /** PELS's writes awaiting Homey's echo (`ownCapabilityWrites.ts`). */
  readonly ownWrites = new OwnCapabilityWrites();
  private readonly observationSeqByDeviceId = new Map<string, number>();
  private readonly realtimeCapabilityEventTimesByKey = new Map<string, number>();
  private readonly binarySettleEvidenceByDeviceId = new Map<string, {
    generation: number | undefined;
    evidence: BinaryControlObservation;
  }>();
  private readonly pendingTemperatureRecoveryDeviceIds = new Set<string>();
  private readonly writtenDeviceIdsSinceRead = new Set<string>();
  private commandOnUnnamedDevicesSinceRead = false;

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
    const current = this.binarySettleEvidenceByDeviceId.get(deviceId);
    return current === undefined ? undefined : cloneBinaryControlObservation(current.evidence);
  }

  readBinarySettleEvidenceForBinding(snapshot: TransportDeviceSnapshot): BinaryControlObservation | undefined {
    const current = this.binarySettleEvidenceByDeviceId.get(snapshot.id);
    if (!current || current.generation !== snapshot.binarySwitchGeneration
        || current.evidence.capabilityId !== snapshot.binaryCapabilityId) return undefined;
    return cloneBinaryControlObservation(current.evidence);
  }

  upsertBinarySettleEvidence(
    snapshot: TransportDeviceSnapshot, evidence: BinaryControlObservation,
  ): BinaryControlObservation {
    const existing = this.readBinarySettleEvidenceForBinding(snapshot);
    if (existing !== undefined && existing.observedAtMs > evidence.observedAtMs) return existing;
    const accepted = cloneBinaryControlObservation(evidence);
    this.binarySettleEvidenceByDeviceId.set(snapshot.id, {
      evidence: accepted, generation: snapshot.binarySwitchGeneration,
    });
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

  /**
   * A write to `deviceId`'s `capabilityId` that Homey answered. Unless its echo
   * already settled it (`OwnCapabilityWrites.settledByEcho`), the device waits
   * for the read that confirms the write landed.
   */
  noteWriteAnswered(
    deviceId: string,
    write: OwnCapabilityWrite,
    snapshot: TransportDeviceSnapshot | undefined,
    capabilityId: string,
  ): void {
    if (snapshot !== undefined && this.ownWrites.settledByEcho(write, snapshot, capabilityId)) return;
    this.requestReadAfterWrite(deviceId);
  }

  requestReadAfterWrite(deviceId: string): void { this.writtenDeviceIdsSinceRead.add(deviceId); }

  /**
   * A command whose devices no capability write names: a Flow card or a
   * battery app's actions carry it out, on whatever devices they drive, so the
   * read that confirms it reads every device.
   */
  noteCommandOnUnnamedDevices(): void {
    this.commandOnUnnamedDevicesSinceRead = true;
  }

  /** Whether a command since the last read still needs one to confirm it: one its echo did not settle. */
  hasCommandAwaitingRead(): boolean {
    return this.commandOnUnnamedDevicesSinceRead || this.writtenDeviceIdsSinceRead.size > 0;
  }

  /** What PELS commanded since the last call (`WrittenSinceRead`), which empties it. */
  takeWrittenSinceRead(): WrittenSinceRead {
    const written: WrittenSinceRead = this.commandOnUnnamedDevicesSinceRead
      ? { kind: 'every_device' }
      : { kind: 'devices', ids: [...this.writtenDeviceIdsSinceRead] };
    this.writtenDeviceIdsSinceRead.clear();
    this.commandOnUnnamedDevicesSinceRead = false;
    return written;
  }

  /** Put back what a read took but did not confirm, so the next read confirms it. */
  restoreWrittenSinceRead(written: WrittenSinceRead, unconfirmedIds: Iterable<string>): void {
    if (written.kind === 'every_device') {
      this.commandOnUnnamedDevicesSinceRead = true;
      return;
    }
    for (const id of unconfirmedIds) this.writtenDeviceIdsSinceRead.add(id);
  }

  markTemperatureRecoveryPending(deviceId: string): void {
    this.pendingTemperatureRecoveryDeviceIds.add(deviceId);
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
    this.writtenDeviceIdsSinceRead.clear();
    this.commandOnUnnamedDevicesSinceRead = false;
  }

  private pruneDuplicateRealtimeCapabilityEvents(nowMs: number): void {
    for (const [key, emittedAtMs] of this.realtimeCapabilityEventTimesByKey) {
      if (nowMs - emittedAtMs > DUPLICATE_EVENT_PRUNE_AFTER_MS) {
        this.realtimeCapabilityEventTimesByKey.delete(key);
      }
    }
  }
}
