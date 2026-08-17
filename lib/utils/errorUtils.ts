const describeErrorValue = (value: unknown): string => {
  if (typeof value === 'string') return value;
  try {
    const serialized = JSON.stringify(value);
    if (typeof serialized === 'string') return serialized;
  } catch {
    // Fall through to String() for circular or host objects.
  }
  return String(value);
};

export const normalizeError = (value: unknown): Error => (
  value instanceof Error ? value : new Error(describeErrorValue(value))
);

/**
 * A request that ran out of time client-side. Distinct from every other
 * rejection the Homey HTTP transport produces, because the OUTCOME IS UNKNOWN
 * rather than failed: aborting the socket abandons our end of the call, but
 * Homey may still be processing the request and may still push it to the
 * device. A 4xx/5xx or a malformed body is a definite answer; this is the
 * absence of one.
 *
 * Consumers must not treat it as "the command did not happen" — see
 * `lib/executor/binaryControlDispatch.ts`, which keeps the pending record armed
 * and lets telemetry settle it instead.
 *
 * It lives in `lib/utils` rather than beside the transport that throws it
 * because both sides of the boundary need it and `lib/executor/**` may import
 * only `lib/device/deviceObservation.ts` (`no-executor-to-device-internals`).
 * The type is the seam; classification still happens exactly once, where the
 * socket times out (root `AGENTS.md` § "Clean and trusted interfaces between
 * layers").
 *
 * Two known unknowns are DELIBERATELY excluded, because separating them needs
 * HTTP mechanics this type does not model, and over-claiming is the worse
 * error. Both stay classified as definite failures:
 *   - a socket `error` after the request was flushed (an ECONNRESET mid-flight)
 *     is equally unanswered;
 *   - a 2xx with an unparseable body is a definite *success* we report as a
 *     failure.
 * Also note Node's `options.timeout` is a socket-IDLE timer, not a deadline: a
 * response that trickles never trips it, so this is not a bound on how long a
 * write can take.
 */
export class HomeyRequestTimeoutError extends Error {
  constructor(method: string, urlPath: string) {
    super(`HTTP ${method} ${urlPath} timed out`);
    this.name = 'HomeyRequestTimeoutError';
  }
}

/**
 * Name-based as well as `instanceof` so the answer survives a realm boundary or
 * a re-thrown copy. The transport chain rethrows the original object today, but
 * an unknown outcome must never be silently re-classified as a definite failure
 * if that ever stops holding.
 */
export const isHomeyRequestTimeout = (value: unknown): boolean => (
  value instanceof HomeyRequestTimeoutError
  || (value instanceof Error && value.name === 'HomeyRequestTimeoutError')
);
