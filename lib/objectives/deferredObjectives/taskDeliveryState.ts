/**
 * Runtime delivery state has no diagnostic reasons or device-specific constraints.
 *
 * Two questions share it. Reservations: only `confirmed` (15 minutes of a
 * claimed, permitted window without draw) frees the task's booked room. A tick
 * PELS holds the device back, or an hour the plan does not book, ends that
 * window, and the next permitted one re-tests the device for 15 minutes with
 * its room held before freeing it again. Status: once confirmed, the device
 * stays "stopped taking power" until it draws again, the task is met, or its
 * plan goes inactive. `stopped` carries that through the ticks that end a
 * window, without freeing any room; `rechecking` is the next permitted window
 * re-testing it. Without the latch those ticks reset the cause, the status
 * flipped back to on track, and the status Flow fired each time the device was
 * confirmed again. `sinceMs` is when the current confirmation or re-test began.
 */
export type TaskNonDeliveryState =
  | { kind: 'none' }
  | { kind: 'watching'; sinceMs: number }
  | { kind: 'confirmed'; sinceMs: number }
  | { kind: 'stopped'; sinceMs: number }
  | { kind: 'rechecking'; sinceMs: number };
export type TaskReservationReader = (deviceId: string, deadlineAtMs: number) => boolean;
export type TaskControlState = 'permitted' | 'restricted' | 'pending' | 'failed' | 'uncontrolled';
export type TaskDeliveryInput = {
  obligation: 'claimed' | 'inactive' | 'deferred' | 'satisfied' | 'expired';
  control: TaskControlState;
  draw: 'drawing' | 'not_drawing' | 'unobserved';
};
export const NON_DELIVERY_HOLD_MS = 15 * 60 * 1000;
export const DELIVERY_EPSILON_KWH = 0.001;

/** Whether the device is known to have stopped taking power: the status latch. */
export const isTaskDeviceStopped = (state: TaskNonDeliveryState): state is Extract<
  TaskNonDeliveryState, { kind: 'confirmed' | 'stopped' | 'rechecking' }
> => state.kind === 'confirmed' || state.kind === 'stopped' || state.kind === 'rechecking';

/**
 * Across a restart a stop stays a stop for the status, and its room is held
 * again until a fresh 15-minute re-test confirms it: no observation spans the
 * downtime. An unconfirmed watch starts over.
 */
export const restoreTaskNonDelivery = (saved: TaskNonDeliveryState): TaskNonDeliveryState => (
  isTaskDeviceStopped(saved) ? { kind: 'stopped', sinceMs: saved.sinceMs } : { kind: 'none' }
);

/**
 * The persisted form. Builds before the latch read only `none`, `watching` and
 * `confirmed`, and reject a whole in-progress run on any other kind, so a
 * latched stop is written as `confirmed`; `restoreTaskNonDelivery` reads it
 * back as `stopped` either way.
 */
export const persistTaskNonDelivery = (state: TaskNonDeliveryState): TaskNonDeliveryState => (
  state.kind === 'stopped' || state.kind === 'rechecking' ? { kind: 'confirmed', sinceMs: state.sinceMs } : state
);

/** Only a claimed, settled, permitted delivery window can release reservations. */
export const observeTaskNonDelivery = (
  previous: TaskNonDeliveryState, input: TaskDeliveryInput, nowMs: number,
): TaskNonDeliveryState => {
  if (input.obligation === 'expired') return previous;
  // Draw, a met task, or a plan that went inactive (the device unavailable, an
  // EV unplugged) ends the stop: each has its own explanation.
  if (input.draw === 'drawing' || input.obligation === 'satisfied' || input.obligation === 'inactive') {
    return { kind: 'none' };
  }
  if (input.obligation !== 'claimed' || input.control !== 'permitted' || input.draw !== 'not_drawing') {
    return isTaskDeviceStopped(previous) ? { kind: 'stopped', sinceMs: previous.sinceMs } : { kind: 'none' };
  }
  if (previous.kind === 'confirmed') return previous;
  if (previous.kind === 'stopped') return { kind: 'rechecking', sinceMs: nowMs };
  const sinceMs = previous.kind === 'none' ? nowMs : previous.sinceMs;
  if (nowMs - sinceMs >= NON_DELIVERY_HOLD_MS) return { kind: 'confirmed', sinceMs };
  return previous.kind === 'rechecking' ? { kind: 'rechecking', sinceMs } : { kind: 'watching', sinceMs };
};
