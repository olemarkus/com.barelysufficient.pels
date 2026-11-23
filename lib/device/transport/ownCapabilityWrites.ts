import { randomUUID } from 'node:crypto';
import type { TransportDeviceSnapshot } from '../transportDeviceSnapshot';
import { TARGET_TEMPERATURE_CAPABILITY_ID } from './temperatureObservation';

/**
 * Whether Homey's echo of a write to `capabilityId` settles it: the device's
 * switch or its setpoint. Homey sends the echo once the driver has taken the
 * write and holds the value, which is the value a read would return then, so
 * the echo confirms the write as a read would and the write needs no read.
 */
export function echoSettlesWrite(snapshot: TransportDeviceSnapshot, capabilityId: string): boolean {
  return capabilityId === snapshot.binaryCapabilityId || capabilityId === TARGET_TEMPERATURE_CAPABILITY_ID;
}

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
  /** The capability the write reached Homey on, which its echo carries. */
  writtenCapabilityId: string;
  sentAtMs: number;
  binaryAuthority?: { generation: number | undefined };
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
    writtenCapabilityId: string,
    nowMs: number,
    binaryAuthority?: OwnCapabilityWrite['binaryAuthority'],
  ): OwnCapabilityWrite {
    this.pruneUnanswered(nowMs);
    const write: OwnCapabilityWrite = {
      transactionId: `pels-${randomUUID()}`,
      deviceId,
      writtenCapabilityId,
      sentAtMs: nowMs,
      ...(binaryAuthority ? { binaryAuthority } : {}),
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

  /**
   * Whether Homey's echo has already settled `write`, sent for `snapshot`'s
   * `capabilityId` (`echoSettlesWrite`). Homey echoes before it answers, so
   * this holds once the write returns. A write a vendor adapter routed to
   * another capability or Homey device is settled by what the adapter reads,
   * never by its echo.
   */
  settledByEcho(write: OwnCapabilityWrite, snapshot: TransportDeviceSnapshot, capabilityId: string): boolean {
    return write.deviceId === snapshot.id && write.writtenCapabilityId === capabilityId
      && echoSettlesWrite(snapshot, capabilityId) && !this.byTransactionId.has(write.transactionId);
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
