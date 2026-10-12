/**
 * The app's one-way teardown signal: tripped once, as the first edge of
 * uninit, and never reset.
 *
 * Read wherever work can still be in flight when teardown starts — the final
 * Main write seam and its persisted-signal writers, the meter-silence
 * escalation, the Main tracker's persistence, and the fire-and-forget
 * native-wiring probe — so a continuation that resumes after uninit drops its
 * side effects instead of acting on a half-torn-down app. There is no reset:
 * nothing un-stops an app.
 */
export class ShutdownLatch {
  private stopped = false;

  stop(): void {
    this.stopped = true;
  }

  isStopped(): boolean {
    return this.stopped;
  }
}
