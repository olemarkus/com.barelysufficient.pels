import { vi } from 'vitest';

const nextTick = (): Promise<void> => new Promise((resolve) => process.nextTick(resolve));

/**
 * Deterministically drive fake timers + the microtask queue until `predicate`
 * holds, or throw after `rounds` attempts.
 *
 * SDK-boundary e2e specs drive a chain of *detached* promises — the energy-poll
 * interval callback is fire-and-forget (`pollNow().catch(...)`), and the executor
 * writes are dispatched with `void Promise.resolve(...)`. The number of microtask
 * turns between "poll fired" and "api.put called" is therefore not fixed, and a
 * single trailing `process.nextTick` flush only happens to be enough on an idle
 * machine. Under load it isn't — which is what made the `*ShedControl` e2e specs
 * flake with "Number of calls: 0". Waiting for the observable condition instead of
 * a fixed flush removes that load-sensitivity without masking a real regression
 * (a genuine failure never satisfies the predicate and this throws).
 *
 * Pair it with a one-shot `vi.advanceTimersByTimeAsync(intervalMs)` to fire the
 * poll, then `await drainUntil(() => putSpy.mock.calls.length > 0)`.
 */
export async function drainUntil(
  predicate: () => boolean,
  { rounds = 50 }: { rounds?: number } = {},
): Promise<void> {
  for (let attempt = 0; attempt < rounds && !predicate(); attempt += 1) {
    // advanceTimersByTimeAsync(0) fires any 0-delay timers scheduled at the
    // current fake time and drains microtasks between them; the nextTick then
    // lets one more detached-promise turn settle before we re-check.
    await vi.advanceTimersByTimeAsync(0);
    await nextTick();
  }
  if (!predicate()) {
    throw new Error(`drainUntil: predicate not satisfied after ${rounds} drain rounds`);
  }
}

type CallSpy = { mock: { calls: unknown[][] } };

/**
 * Drain until `spy` has been called with `expectedArgs` (leading-args match), or
 * throw. Use for SDK-write assertions where a later step issues a second write:
 * wait for *that* write, not merely "any call has happened", so the drain doesn't
 * return early on a prior cycle's write. Keep the subsequent
 * `expect(spy).toHaveBeenCalledWith(...)` for a readable diff — it's guaranteed
 * to hold once this resolves.
 */
export async function drainUntilCalledWith(spy: CallSpy, ...expectedArgs: unknown[]): Promise<void> {
  const want = JSON.stringify(expectedArgs);
  await drainUntil(() => spy.mock.calls.some(
    (call) => JSON.stringify(call.slice(0, expectedArgs.length)) === want,
  ));
}
