/**
 * How long a command waits for telemetry to confirm it. Setpoint, step and
 * battery commands always wait this long, and so does an on/off command to a
 * device whose on/off window is not learned ({@link ConfirmationWindows}). A
 * neutral port so every consumer names it without importing a peer.
 */
export const CONTROL_COMMAND_CONFIRMATION_MS = 90 * 1000;

/**
 * Each device's on/off confirmation window, by direction. Transport learns it
 * from how long Homey takes to answer PELS's on/off writes to the device
 * (`lib/device/transport/writeAnswerTimes.ts`); a device it has not learned
 * yet keeps {@link CONTROL_COMMAND_CONFIRMATION_MS}. A command takes the window
 * once, when it is sent, and keeps it until it is confirmed or expires.
 */
export type ConfirmationWindows = {
  windowMs(deviceId: string, desired: boolean, nowMs: number): number;
  /** An on/off command went unconfirmed within the window it took: report it to the owner of that window. */
  unconfirmed(deviceId: string): void;
};

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
