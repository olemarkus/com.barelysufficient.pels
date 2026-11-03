/** Observer-owned freshness policy; command facts live in neutral runtime ports. */
import { CONTROL_COMMAND_CONFIRMATION_MS } from '../ports/controlCommandConfirmation';
import type { PendingBinaryCommandRead } from '../ports/pendingBinaryCommand';

export function isPendingBinaryCommandActive(params: {
  pending?: PendingBinaryCommandRead;
  nowMs?: number;
}): boolean {
  const { pending, nowMs = Date.now() } = params;
  if (!pending) return false;
  return (nowMs - pending.startedMs) < CONTROL_COMMAND_CONFIRMATION_MS;
}
