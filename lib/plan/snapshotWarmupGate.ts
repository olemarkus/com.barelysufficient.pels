/**
 * Holds the first plan rebuild and the first `statusBus` publish until the
 * first device snapshot lands, so the planner does not run against an empty
 * `latestSnapshot` and emit a one-cycle
 * `deferred_objective_unknown reasonCode:objective_missing_device` event on
 * every restart.
 *
 * Bounded by a configurable timeout so a failed or slow Homey Manager fetch
 * cannot deadlock startup: when the bound elapses the gate releases with
 * reason `timeout` and the planner proceeds with whatever snapshot it has
 * (empty snapshot still produces a valid horizon plan on the next cycle once
 * the snapshot lands). Per `feedback_homey_sdk_unreliable`, transient SDK
 * failures must not corrupt persisted state; the gate only delays the
 * first rebuild, never abandons it.
 */
export type SnapshotWarmupGateReleaseReason = 'snapshot_ready' | 'timeout';

export type SnapshotWarmupGateOptions = {
  timeoutMs: number;
  setTimeoutFn?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  clearTimeoutFn?: (handle: ReturnType<typeof setTimeout>) => void;
  onRelease?: (reason: SnapshotWarmupGateReleaseReason) => void;
};

export class SnapshotWarmupGate {
  private released = false;

  private releaseReason: SnapshotWarmupGateReleaseReason | null = null;

  private waitPromise: Promise<void>;

  private resolveWait: () => void = () => undefined;

  private timer: ReturnType<typeof setTimeout> | undefined;

  private readonly setTimeoutFn: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;

  private readonly clearTimeoutFn: (handle: ReturnType<typeof setTimeout>) => void;

  private readonly onRelease?: (reason: SnapshotWarmupGateReleaseReason) => void;

  constructor(options: SnapshotWarmupGateOptions) {
    this.setTimeoutFn = options.setTimeoutFn ?? ((callback, delayMs) => setTimeout(callback, delayMs));
    this.clearTimeoutFn = options.clearTimeoutFn ?? ((handle) => clearTimeout(handle));
    this.onRelease = options.onRelease;
    this.waitPromise = new Promise<void>((resolve) => {
      this.resolveWait = resolve;
    });
    const timeoutMs = Math.max(0, options.timeoutMs);
    if (timeoutMs === 0) {
      this.release('timeout');
      return;
    }
    this.timer = this.setTimeoutFn(() => {
      this.timer = undefined;
      this.release('timeout');
    }, timeoutMs);
    // Don't keep the event loop alive just for the warmup timeout; the
    // snapshot bootstrap will release the gate first under normal startup.
    (this.timer as { unref?: () => void }).unref?.();
  }

  wait(): Promise<void> {
    return this.waitPromise;
  }

  release(reason: SnapshotWarmupGateReleaseReason): void {
    if (this.released) return;
    this.released = true;
    this.releaseReason = reason;
    if (this.timer) {
      this.clearTimeoutFn(this.timer);
      this.timer = undefined;
    }
    this.resolveWait();
    this.onRelease?.(reason);
  }

  isReleased(): boolean {
    return this.released;
  }

  getReleaseReason(): SnapshotWarmupGateReleaseReason | null {
    return this.releaseReason;
  }
}
