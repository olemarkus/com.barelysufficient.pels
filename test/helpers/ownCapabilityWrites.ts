import { expect, type Mock } from 'vitest';

/** The PUT body PELS sends for a capability write: the value and its own transaction id. */
export const pelsCapabilityWrite = (value: unknown) => ({
  value,
  transactionId: expect.stringMatching(/^pels-/),
});

/**
 * The transaction id of PELS's latest PUT to a device capability, which Homey's
 * echo of that write carries back. Throws when PELS wrote no such capability.
 */
export function ownWriteTransactionId(put: Mock, deviceId: string, capabilityId: string): string {
  const path = `manager/devices/device/${deviceId}/capability/${capabilityId}`;
  const call = [...put.mock.calls].reverse().find(([callPath]) => callPath === path);
  const transactionId = (call?.[1] as { transactionId?: unknown } | undefined)?.transactionId;
  if (typeof transactionId !== 'string') throw new Error(`PELS sent no write to ${path}`);
  return transactionId;
}
