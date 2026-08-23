/**
 * Stepped-load command-pending policy. The BINARY half moved to
 * `lib/observer/pendingBinaryCommandTypes.ts` as part of PR #4 of the
 * observer/transport split (see
 * `notes/state-management/observer-transport-split.md`), and its freshness
 * predicate was re-exported here for the plan-side readers that still
 * hand-rolled "is a command in flight". They no longer do — `PendingBinaryCommandStore`
 * answers that itself (`hasActiveCommand` / `hasActiveTurnOn` /
 * `hasActiveTurnOff`) — so the re-export is gone. Import from observer directly.
 */
import {
  LOCAL_CONTROL_COMMAND_CONFIRMATION_MS,
  resolveControlCommandConfirmationMs,
  type CommunicationModel,
} from '../observer/controlCommandConfirmation';

export const LOCAL_STEPPED_LOAD_COMMAND_PENDING_MS = LOCAL_CONTROL_COMMAND_CONFIRMATION_MS;

export function resolveSteppedLoadCommandPendingMs(communicationModel?: CommunicationModel): number {
  return resolveControlCommandConfirmationMs(communicationModel ?? 'local');
}
