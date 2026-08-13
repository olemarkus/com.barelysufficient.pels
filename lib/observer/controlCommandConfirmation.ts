/**
 * One observer-owned confirmation policy for every control axis.
 *
 * Command kind is deliberately absent: a binary switch, temperature target,
 * and stepped target on the same transport deserve the same observation
 * window. Only the device communication model changes the timeout.
 */
export const LOCAL_CONTROL_COMMAND_CONFIRMATION_MS = 90 * 1000;
export const CLOUD_CONTROL_COMMAND_CONFIRMATION_MS = 3 * 60 * 1000;

export type CommunicationModel = 'local' | 'cloud';

export function resolveControlCommandConfirmationMs(
  communicationModel: CommunicationModel,
): number {
  return communicationModel === 'cloud'
    ? CLOUD_CONTROL_COMMAND_CONFIRMATION_MS
    : LOCAL_CONTROL_COMMAND_CONFIRMATION_MS;
}
