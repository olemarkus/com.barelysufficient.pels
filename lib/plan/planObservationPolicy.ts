import { BINARY_COMMAND_PENDING_MS } from './planConstants';
import type { PlanEngineState } from './planState';

export const CLOUD_BINARY_COMMAND_PENDING_MS = 75 * 1000;
export const LOCAL_STEPPED_LOAD_COMMAND_PENDING_MS = 90 * 1000;
export const CLOUD_STEPPED_LOAD_COMMAND_PENDING_MS = 3 * 60 * 1000;

type CommunicationModel = 'local' | 'cloud' | undefined;

export function resolveBinaryCommandPendingMs(communicationModel?: CommunicationModel): number {
  return communicationModel === 'cloud' ? CLOUD_BINARY_COMMAND_PENDING_MS : BINARY_COMMAND_PENDING_MS;
}

export function resolveSteppedLoadCommandPendingMs(communicationModel?: CommunicationModel): number {
  return communicationModel === 'cloud'
    ? CLOUD_STEPPED_LOAD_COMMAND_PENDING_MS
    : LOCAL_STEPPED_LOAD_COMMAND_PENDING_MS;
}

export function getPendingBinaryCommandWindowMs(
  pending: PlanEngineState['pendingBinaryCommands'][string],
  communicationModel?: CommunicationModel,
): number {
  return pending.pendingMs ?? resolveBinaryCommandPendingMs(communicationModel);
}

export function isPendingBinaryCommandActive(params: {
  pending?: PlanEngineState['pendingBinaryCommands'][string];
  nowMs?: number;
  communicationModel?: CommunicationModel;
}): boolean {
  const { pending, nowMs = Date.now(), communicationModel } = params;
  if (!pending) return false;
  return (nowMs - pending.startedMs) < getPendingBinaryCommandWindowMs(pending, communicationModel);
}
