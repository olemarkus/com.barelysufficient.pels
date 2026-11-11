/**
 * A device write refused unsent because the previous write to the same device
 * is still outstanding past its caller's timeout: a slow cloud action card can
 * answer long after PELS stopped waiting. Like a timeout, the device's state is
 * unknown rather than failed (the earlier write may still land), so the same
 * seam carries it inward and the executor paces the retry instead of failing.
 */
export class HomeyRequestInFlightError extends Error {
  constructor() {
    super('The previous command to this device is still running.');
    this.name = 'HomeyRequestInFlightError';
  }
}

/** Name-based as well as `instanceof`, for the same reason as `isHomeyRequestTimeout` (`errorUtils.ts`). */
export const isHomeyRequestInFlight = (value: unknown): boolean => (
  value instanceof HomeyRequestInFlightError
  || (value instanceof Error && value.name === 'HomeyRequestInFlightError')
);
