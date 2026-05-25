/**
 * Binary-command policy (window length + freshness predicate) moved to
 * `lib/observer/pendingBinaryCommandTypes.ts` as part of PR #4 of the
 * observer/transport split (see
 * `notes/state-management/observer-transport-split.md`). Only the
 * predicate consumed by surviving plan-side readers is re-exported
 * here; new code should import from observer directly.
 */
export { isPendingBinaryCommandActive } from '../observer/pendingBinaryCommandTypes';

export const LOCAL_STEPPED_LOAD_COMMAND_PENDING_MS = 90 * 1000;
export const CLOUD_STEPPED_LOAD_COMMAND_PENDING_MS = 3 * 60 * 1000;

type CommunicationModel = 'local' | 'cloud' | undefined;

export function resolveSteppedLoadCommandPendingMs(communicationModel?: CommunicationModel): number {
  return communicationModel === 'cloud'
    ? CLOUD_STEPPED_LOAD_COMMAND_PENDING_MS
    : LOCAL_STEPPED_LOAD_COMMAND_PENDING_MS;
}
