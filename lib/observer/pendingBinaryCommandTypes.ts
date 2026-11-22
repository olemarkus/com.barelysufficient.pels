/** Observer-owned freshness policy; command facts live in neutral runtime ports. */
import type { PendingBinaryCommandRead } from '../ports/pendingBinaryCommand';

export function isPendingBinaryCommandActive(params: {
  pending?: PendingBinaryCommandRead;
  nowMs?: number;
}): boolean {
  const { pending, nowMs = Date.now() } = params;
  if (!pending) return false;
  return (nowMs - pending.startedMs) < pending.confirmationWindowMs;
}
