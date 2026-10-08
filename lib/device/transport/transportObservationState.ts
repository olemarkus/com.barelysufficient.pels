/**
 * Owns the transport's transient observation bookkeeping. Callers decide when
 * to refresh and emit; this state only records facts, ordering, and recovery
 * work that is still pending.
 */
import type { BinaryControlObservation } from '../../../packages/contracts/src/types';
import type { SteppedLoadWrite } from '../../ports/steppedLoadWrite';
import { createObservationState, type DeviceTransportObservationState } from './observationState';
import type {
  RecentLocalCapabilityWrite,
  RecentLocalCapabilityWrites,
} from './managerRealtimeSupport';
import { cloneBinaryControlObservation } from './transportTypes';

export type TransportObservationCursor = {
  observationSeq: number;
  observedAtMs: number;
};

const LOCAL_CAPABILITY_ECHO_SUPPRESS_MS = 5_000;
const DUPLICATE_EVENT_PRUNE_AFTER_MS = 10 * 60 * 1_000;

export class TransportObservationState {
  private readonly observations = createObservationState();
  private readonly observationSeqByDeviceId = new Map<string, number>();
  private readonly localCapabilityWrites: RecentLocalCapabilityWrites = new Map();
  private readonly nativeStepCommands = new Map<string, { command: SteppedLoadWrite; reportedStepId?: string }>();
  private readonly realtimeCapabilityEventTimesByKey = new Map<string, number>();
  private readonly binarySettleEvidenceByDeviceId = new Map<string, BinaryControlObservation>();
  private readonly pendingTemperatureRecoveryDeviceIds = new Set<string>();
  private readonly temperatureRecoveryRefreshInFlightDeviceIds = new Set<string>();

  getObservationState(): DeviceTransportObservationState {
    return this.observations;
  }

  nextCursor(deviceId: string, observedAtMs: number = Date.now()): TransportObservationCursor {
    const observationSeq = (this.observationSeqByDeviceId.get(deviceId) ?? 0) + 1;
    this.observationSeqByDeviceId.set(deviceId, observationSeq);
    return { observationSeq, observedAtMs };
  }

  recordLocalCapabilityWrite(
    deviceId: string,
    capabilityId: string,
    value: unknown,
    recordedAtMs: number = Date.now(),
  ): void {
    this.localCapabilityWrites.set(capabilityWriteKey(deviceId, capabilityId), {
      value,
      expiresAt: recordedAtMs + LOCAL_CAPABILITY_ECHO_SUPPRESS_MS,
    });
  }

  clearLocalCapabilityWrite(deviceId: string, capabilityId: string): void {
    this.localCapabilityWrites.delete(capabilityWriteKey(deviceId, capabilityId));
  }

  beginNativeStepCommand(command: SteppedLoadWrite): void {
    this.nativeStepCommands.set(command.deviceId, { command });
  }

  /** Fold only matching telemetry received during the write into its outcome log. */
  recordNativeStepCommandReport(deviceId: string, reportedStepId: string | undefined): boolean {
    const pending = this.nativeStepCommands.get(deviceId);
    if (!pending) return false;
    if (pending.command.desiredStepId !== reportedStepId) {
      delete pending.reportedStepId;
      return false;
    }
    pending.reportedStepId = reportedStepId;
    return true;
  }

  finishNativeStepCommand(deviceId: string): string | undefined {
    const reportedStepId = this.nativeStepCommands.get(deviceId)?.reportedStepId;
    this.nativeStepCommands.delete(deviceId);
    return reportedStepId;
  }

  getRecentLocalCapabilityWrite(
    deviceId: string,
    capabilityId: string,
    nowMs: number = Date.now(),
  ): RecentLocalCapabilityWrite | undefined {
    const key = capabilityWriteKey(deviceId, capabilityId);
    const entry = this.localCapabilityWrites.get(key);
    if (entry === undefined) return undefined;
    if (entry.expiresAt > nowMs) return entry;
    this.localCapabilityWrites.delete(key);
    return undefined;
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
    this.observations.latestLocalWriteMsByDeviceId.clear();
    this.observationSeqByDeviceId.clear();
    this.localCapabilityWrites.clear();
    this.nativeStepCommands.clear();
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

function capabilityWriteKey(deviceId: string, capabilityId: string): string {
  return `${deviceId}:${capabilityId}`;
}
