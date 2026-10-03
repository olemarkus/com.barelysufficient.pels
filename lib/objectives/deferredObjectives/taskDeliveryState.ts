/** Runtime delivery state has no diagnostic reasons or device-specific constraints. */
export type TaskNonDeliveryState =
  | { kind: 'none' }
  | { kind: 'watching'; sinceMs: number }
  | { kind: 'confirmed'; sinceMs: number };
export type TaskReservationReader = (deviceId: string, deadlineAtMs: number) => boolean;
export type TaskControlState = 'permitted' | 'restricted' | 'pending' | 'failed' | 'uncontrolled';
export type TaskDeliveryInput = {
  obligation: 'claimed' | 'unclaimed' | 'inactive' | 'deferred' | 'satisfied' | 'expired';
  control: TaskControlState;
  draw: 'drawing' | 'not_drawing' | 'unobserved';
};
export const NON_DELIVERY_HOLD_MS = 15 * 60 * 1000;
export const DELIVERY_EPSILON_KWH = 0.001;

/** Only a claimed, settled, permitted delivery window can release reservations. */
export const observeTaskNonDelivery = (
  previous: TaskNonDeliveryState, input: TaskDeliveryInput, nowMs: number,
): TaskNonDeliveryState => {
  if (input.obligation === 'expired') return previous;
  if (input.obligation !== 'claimed' || input.control !== 'permitted'
    || input.draw !== 'not_drawing') return { kind: 'none' };
  const sinceMs = previous.kind === 'none' ? nowMs : previous.sinceMs;
  return nowMs - sinceMs >= NON_DELIVERY_HOLD_MS
    ? { kind: 'confirmed', sinceMs } : { kind: 'watching', sinceMs };
};
