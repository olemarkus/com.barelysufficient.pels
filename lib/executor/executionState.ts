import type { PendingBinaryCommand } from '../ports/pendingBinaryCommand';
import { ActuationRecord } from './actuationRecord';
import type { PendingTargetCommandRead } from '../ports/pendingTargetCommand';

/** Mutable records belong to execution; consumers receive PendingTargetCommandRead. */
export type PendingTargetCommandState = {
  -readonly [Key in keyof PendingTargetCommandRead]: PendingTargetCommandRead[Key]
};

/** One per home, shared by ordinary command materialization and its read projections. */
export class ExecutionState {
  readonly actuation = new ActuationRecord();
  /** Mutated only by the observer-owned pending-binary store. */
  readonly pendingBinaryCommands: Record<string, PendingBinaryCommand> = {};
  readonly pendingTargetCommands: Record<string, PendingTargetCommandState> = {};

  hasPendingTargetCommands(): boolean {
    return Object.keys(this.pendingTargetCommands).length > 0;
  }

  hasPendingTargetCommandsOlderThan(thresholdMs: number): boolean {
    const nowMs = Date.now();
    return Object.values(this.pendingTargetCommands)
      .some((pending) => (nowMs - pending.startedMs) >= thresholdMs);
  }

  deletePendingTargetCommand(deviceId: string): void {
    delete this.pendingTargetCommands[deviceId];
  }
}
