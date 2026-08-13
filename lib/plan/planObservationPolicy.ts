/**
 * Binary-command policy (window length + freshness predicate) moved to
 * `lib/observer/pendingBinaryCommandTypes.ts` as part of PR #4 of the
 * observer/transport split (see
 * `notes/state-management/observer-transport-split.md`). Only the
 * predicate consumed by surviving plan-side readers is re-exported
 * here; new code should import from observer directly.
 */
export { isPendingBinaryCommandActive } from '../observer/pendingBinaryCommandTypes';

import {
  LOCAL_CONTROL_COMMAND_CONFIRMATION_MS,
  resolveControlCommandConfirmationMs,
  type CommunicationModel,
} from '../observer/controlCommandConfirmation';

export const LOCAL_STEPPED_LOAD_COMMAND_PENDING_MS = LOCAL_CONTROL_COMMAND_CONFIRMATION_MS;

export function resolveSteppedLoadCommandPendingMs(communicationModel?: CommunicationModel): number {
  return resolveControlCommandConfirmationMs(communicationModel ?? 'local');
}
