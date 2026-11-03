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
 * How long a stepped command the device has ACKNOWLEDGED (echoed the commanded
 * step as its accepted setting after the command was issued) waits for its
 * settled report before it is treated as unconfirmed and retried. Acknowledged
 * is not settled: the planner keeps planning on measured draw meanwhile.
 *
 * Longer than `CONTROL_COMMAND_CONFIRMATION_MS` because the device has already
 * said it heard the command, and a cloud car reports its actual charge current
 * and power only on its own poll, about every 15 minutes while charging.
 * Re-sending an accepted command inside that interval adds nothing and can cost
 * the owner a paid vehicle API call each time. 20 minutes covers one poll with
 * margin. Without an acknowledgement the 90 s window and the retry ladder apply
 * unchanged.
 */
export const ACKNOWLEDGED_COMMAND_SETTLE_MS = 20 * 60 * 1000;

/** Repeat cadence for diagnostics while a target write awaits observation. */
export const TARGET_WAITING_LOG_REPEAT_MS = 60 * 1000;

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

/** Accepted observation delivery paths that can settle a pending command. */
export type PendingObservationSource =
  | 'rebuild'
  | 'snapshot_refresh'
  | 'realtime_capability'
  | 'device_update';
