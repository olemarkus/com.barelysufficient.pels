/**
 * One confirmation window for every control axis AND every device: how long a
 * command waits for telemetry to confirm it. The observer confirms pending
 * commands against it; the executor, the planner and the battery control
 * owner (which reads a battery's claim against PELS's last claim write) time
 * their own waits by it. A neutral port so every one of them names it
 * without importing a peer.
 *
 * Command kind is deliberately absent: a binary switch, temperature target,
 * and stepped target on the same transport deserve the same observation
 * window. The per-device cloud tier (3 min) was removed 2026-09-01 together
 * with the `device_communication_models` settings map that fed it — nothing
 * ever wrote that map, so every device already ran this window in practice.
 */
export const CONTROL_COMMAND_CONFIRMATION_MS = 90 * 1000;

/**
 * A device as binary-command confirmation reads it: transport projects only
 * these confirmation facts (`binaryCommandConfirmationSnapshot.ts`), and the
 * observer's settle sweep confirms pending commands against them. Raw
 * capability and Flow bindings never enter this handoff.
 */
export type PendingBinaryLiveDevice = {
  id: string;
  name: string;
  binaryCommandConfirmation:
    | { state: 'unavailable' }
    | {
      state: 'observed';
      observedValue: boolean;
      observedAtMs: number;
    };
};
