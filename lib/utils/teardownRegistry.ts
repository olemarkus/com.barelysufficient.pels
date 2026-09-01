/**
 * Named stop callbacks, so a component that starts long-lived work does not
 * have to remember a field per task.
 *
 * The sibling of `TimerRegistry`, for the things a timer handle cannot express:
 * a listener subscription, a poll loop, a process-event handler.
 *
 * **Registering over a held key is refused, on purpose.** `TimerRegistry` can
 * clear-then-replace safely because a `setTimeout` handle is independent of the
 * one it displaces. A stop CALLBACK usually is not: it is frequently a method
 * bound to a shared instance — `WeatherCollector.start()` returns
 * `() => this.stop()` on the collector itself. Write the convenient-looking
 * `register(key, thing.start())` against such a callback and the argument is
 * evaluated first, so the replacement starts and is then torn down by the
 * predecessor's stop, leaving the task dead with no error to show for it.
 * Refusing the silent replace makes that sequence impossible to write: a caller
 * restarting a task must `clear` first, which is the correct order anyway.
 *
 * A registration is one-shot: `clear` runs the callback and forgets it, so a
 * second `clear` — or a `clear` after teardown already ran — is a no-op rather
 * than a double stop.
 *
 * Teardown ORDER is the caller's to state, not this registry's to infer.
 * Registration order is startup order, which is not generally the order things
 * should be torn down in, so `clearAll` is deliberately absent: a caller that
 * cares names its keys in the order it wants.
 */
export class TeardownRegistry {
  private readonly stops = new Map<string, () => void>();

  /**
   * Hold `stop` under `key`, which must be free. Throws otherwise — see the
   * class docblock for why replacing is refused rather than handled.
   */
  register(key: string, stop: () => void): void {
    if (this.stops.has(key)) {
      throw new Error(`teardown key '${key}' is already held; clear it before registering`);
    }
    this.stops.set(key, stop);
  }

  /** Whether a callback is currently held under `key`. */
  has(key: string): boolean {
    return this.stops.has(key);
  }

  /** Run and forget the callback under `key`. Absent key: nothing happens. */
  clear(key: string): void {
    const stop = this.stops.get(key);
    if (stop === undefined) return;
    // Deleted BEFORE it runs, so a callback that re-registers its key during
    // teardown is kept rather than dropped by this delete.
    this.stops.delete(key);
    stop();
  }
}
