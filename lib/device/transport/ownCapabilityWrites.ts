import { randomUUID } from 'node:crypto';

/**
 * How long an unanswered write waits for its echo. Homey answers a write when
 * the driver's capability listener returns, which takes seconds and can take
 * tens of seconds for a cloud device; a write whose echo never comes (the live
 * feed was down) is forgotten after this.
 */
const OWN_WRITE_ECHO_WAIT_MS = 10 * 60 * 1000;

/** A capability write PELS sent, by the transaction id Homey echoes back. */
export type OwnCapabilityWrite = {
  transactionId: string;
  deviceId: string;
  /** The capability PELS was asked to set. */
  requestedCapabilityId: string;
  /** The capability the write reached Homey on, which its echo carries. */
  writtenCapabilityId: string;
  sentAtMs: number;
};

/**
 * Owner: transport. PELS's capability writes awaiting Homey's echo. Every write
 * carries a transaction id of PELS's own, and Homey's capability event for the
 * write carries it back, so an echo is recognised exactly; any other event for
 * the capability, whatever its value, is not PELS's. Homey gives writes without
 * an id and the driver's own reports random ids, so no one else's id can match.
 */
export class OwnCapabilityWrites {
  private readonly byTransactionId = new Map<string, OwnCapabilityWrite>();

  begin(
    deviceId: string,
    requestedCapabilityId: string,
    writtenCapabilityId: string,
    nowMs: number,
  ): OwnCapabilityWrite {
    this.pruneUnanswered(nowMs);
    const write: OwnCapabilityWrite = {
      transactionId: `pels-${randomUUID()}`,
      deviceId,
      requestedCapabilityId,
      writtenCapabilityId,
      sentAtMs: nowMs,
    };
    this.byTransactionId.set(write.transactionId, write);
    return write;
  }

  /** The write this capability event echoes, consumed; undefined for any event that is not PELS's echo. */
  takeEcho(deviceId: string, capabilityId: string, transactionId: string | undefined): OwnCapabilityWrite | undefined {
    if (transactionId === undefined) return undefined;
    const write = this.byTransactionId.get(transactionId);
    if (write === undefined || write.deviceId !== deviceId || write.writtenCapabilityId !== capabilityId) {
      return undefined;
    }
    this.byTransactionId.delete(transactionId);
    return write;
  }

  clear(): void {
    this.byTransactionId.clear();
  }

  private pruneUnanswered(nowMs: number): void {
    for (const [transactionId, write] of this.byTransactionId) {
      if (nowMs - write.sentAtMs > OWN_WRITE_ECHO_WAIT_MS) this.byTransactionId.delete(transactionId);
    }
  }
}
