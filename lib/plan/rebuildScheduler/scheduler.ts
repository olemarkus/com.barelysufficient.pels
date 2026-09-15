import type { PowerSampleRebuildTrigger } from '../planRebuildTrigger';

/**
 * A power-driven rebuild the throttle asked for. A hard-cap breach outranks an
 * ordinary signal: it replaces a pending signal, and a signal arriving behind a
 * pending breach is dropped.
 */
export type RebuildIntent = {
  kind: 'hardCap' | 'signal';
  reason: PowerSampleRebuildTrigger;
};

type RebuildIntentKind = RebuildIntent['kind'];

type TimerHandle = ReturnType<typeof setTimeout>;

const priorityByKind: Record<RebuildIntentKind, number> = {
  hardCap: 0,
  signal: 1,
};

/** `dropped`: a higher-priority intent is already pending, and this one was not queued. */
export type RequestResult = 'queued' | 'dropped';

type PlanRebuildSchedulerDeps = {
  /** When the intent may run. The throttle always has an answer. */
  resolveDueAtMs: (intent: RebuildIntent, nowMs: number) => number;
  executeIntent: (intent: RebuildIntent) => Promise<void>;
  onIntentDropped: (dropped: RebuildIntent, kept: RebuildIntent) => void;
  onPendingIntentReplaced: (previous: RebuildIntent, next: RebuildIntent) => void;
  onIntentCancelled: (intent: RebuildIntent, reason: string) => void;
  onIntentError: (intent: RebuildIntent, error: Error) => void;
  getNowMs: () => number;
  setTimeoutFn: (callback: () => void, delayMs: number) => TimerHandle;
  clearTimeoutFn: (handle: TimerHandle) => void;
};

const comparePriority = (left: RebuildIntentKind, right: RebuildIntentKind): number => (
  priorityByKind[left] - priorityByKind[right]
);

export class PlanRebuildScheduler {
  private activeIntent: RebuildIntent | null = null;

  private pendingIntent: RebuildIntent | null = null;

  private timer?: TimerHandle;

  constructor(private readonly deps: PlanRebuildSchedulerDeps) {}

  request(intent: RebuildIntent): RequestResult {
    const previousIntent = this.pendingIntent;
    if (previousIntent === null) {
      this.pendingIntent = intent;
      this.refreshPendingSchedule();
      return 'queued';
    }

    const priorityComparison = comparePriority(intent.kind, previousIntent.kind);
    if (priorityComparison > 0) {
      this.deps.onIntentDropped(intent, previousIntent);
      return 'dropped';
    }

    this.pendingIntent = intent;
    this.deps.onPendingIntentReplaced(previousIntent, intent);
    this.refreshPendingSchedule();
    return 'queued';
  }

  cancelAll(reason: string): void {
    this.clearTimer();
    if (this.pendingIntent) {
      this.deps.onIntentCancelled(this.pendingIntent, reason);
    }
    this.pendingIntent = null;
  }

  private refreshPendingSchedule(): void {
    if (!this.pendingIntent) return;
    if (this.activeIntent) {
      this.clearTimer();
      return;
    }
    const nowMs = this.deps.getNowMs();
    const dueMs = this.deps.resolveDueAtMs(this.pendingIntent, nowMs);
    if (dueMs <= nowMs) {
      this.clearTimer();
      this.dispatchPendingIntent();
      return;
    }
    this.armTimer(dueMs - nowMs);
  }

  private armTimer(delayMs: number): void {
    this.clearTimer();
    this.timer = this.deps.setTimeoutFn(() => {
      this.timer = undefined;
      this.dispatchPendingIntent();
    }, delayMs);
  }

  private clearTimer(): void {
    if (!this.timer) return;
    this.deps.clearTimeoutFn(this.timer);
    this.timer = undefined;
  }

  private dispatchPendingIntent(): void {
    const intent = this.pendingIntent;
    if (!intent) return;
    if (this.activeIntent) {
      this.refreshPendingSchedule();
      return;
    }

    const nowMs = this.deps.getNowMs();
    const dueMs = this.deps.resolveDueAtMs(intent, nowMs);
    if (dueMs > nowMs) {
      this.armTimer(dueMs - nowMs);
      return;
    }

    this.pendingIntent = null;
    this.activeIntent = intent;

    this.deps.executeIntent(intent)
      .catch((error: unknown) => {
        this.deps.onIntentError(intent, error instanceof Error ? error : new Error(String(error)));
      })
      .finally(() => {
        this.activeIntent = null;
        if (this.pendingIntent) {
          this.refreshPendingSchedule();
        }
      });
  }
}
