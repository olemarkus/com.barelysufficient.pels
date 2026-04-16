export type RebuildReason = string;

export type RebuildIntent =
  | { kind: 'hardCap'; reason: RebuildReason }
  | { kind: 'signal'; reason: RebuildReason }
  | { kind: 'flow'; reason: RebuildReason }
  | { kind: 'snapshot'; reason: RebuildReason };

type RebuildIntentKind = RebuildIntent['kind'];

type TimerHandle = ReturnType<typeof setTimeout>;

const priorityByKind: Record<RebuildIntentKind, number> = {
  hardCap: 0,
  signal: 1,
  flow: 2,
  snapshot: 3,
};

export type SchedulerState = {
  nowMs: number;
  activeIntent: RebuildIntent | null;
  pendingIntent: RebuildIntent | null;
  pendingDueMs: number | null;
  hasTimer: boolean;
  lastCompletedAtMsByKind: Partial<Record<RebuildIntentKind, number>>;
};

export type RequestResult =
  | { status: 'accepted'; keptIntent: RebuildIntent }
  | { status: 'replaced'; keptIntent: RebuildIntent }
  | { status: 'dropped'; keptIntent: RebuildIntent };

type PlanRebuildSchedulerDeps = {
  resolveDueAtMs: (intent: RebuildIntent, state: SchedulerState) => number;
  executeIntent: (intent: RebuildIntent) => Promise<void> | void;
  shouldExecuteImmediately?: (intent: RebuildIntent, state: SchedulerState) => boolean;
  onIntentDropped?: (dropped: RebuildIntent, kept: RebuildIntent) => void;
  onPendingIntentReplaced?: (previous: RebuildIntent, next: RebuildIntent) => void;
  onIntentCancelled?: (intent: RebuildIntent, reason: string) => void;
  onIntentError?: (intent: RebuildIntent, error: Error) => void;
  getNowMs?: () => number;
  setTimeoutFn?: (callback: () => void, delayMs: number) => TimerHandle;
  clearTimeoutFn?: (handle: TimerHandle) => void;
};

const defaultNowMs = (): number => (
  typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now()
);

const comparePriority = (left: RebuildIntentKind, right: RebuildIntentKind): number => (
  priorityByKind[left] - priorityByKind[right]
);

export class PlanRebuildScheduler {
  private activeIntent: RebuildIntent | null = null;

  private pendingIntent: RebuildIntent | null = null;

  private pendingDueMs: number | null = null;

  private timer?: TimerHandle;

  private readonly lastCompletedAtMsByKind: Partial<Record<RebuildIntentKind, number>> = {};

  private readonly getNowMs: () => number;

  private readonly setTimeoutFn: (callback: () => void, delayMs: number) => TimerHandle;

  private readonly clearTimeoutFn: (handle: TimerHandle) => void;

  constructor(private readonly deps: PlanRebuildSchedulerDeps) {
    this.getNowMs = deps.getNowMs ?? defaultNowMs;
    this.setTimeoutFn = deps.setTimeoutFn ?? ((callback, delayMs) => setTimeout(callback, delayMs));
    this.clearTimeoutFn = deps.clearTimeoutFn ?? ((handle) => clearTimeout(handle));
  }

  request(intent: RebuildIntent): RequestResult {
    const nowMs = this.getNowMs();
    const dueMs = this.resolveDueAtMs(intent, nowMs);

    if (!this.pendingIntent) {
      this.pendingIntent = intent;
      this.pendingDueMs = dueMs;
      this.refreshPendingSchedule();
      return { status: 'accepted', keptIntent: intent };
    }

    const priorityComparison = comparePriority(intent.kind, this.pendingIntent.kind);
    if (priorityComparison > 0) {
      this.deps.onIntentDropped?.(intent, this.pendingIntent);
      return { status: 'dropped', keptIntent: this.pendingIntent };
    }

    const previousIntent = this.pendingIntent;
    if (priorityComparison < 0 || previousIntent.kind === intent.kind) {
      this.pendingIntent = intent;
      this.pendingDueMs = priorityComparison < 0
        ? dueMs
        : Math.min(this.pendingDueMs ?? dueMs, dueMs);
      this.deps.onPendingIntentReplaced?.(previousIntent, intent);
      this.refreshPendingSchedule();
      return {
        status: priorityComparison < 0 ? 'replaced' : 'accepted',
        keptIntent: intent,
      };
    }

    this.deps.onIntentDropped?.(intent, previousIntent);
    return { status: 'dropped', keptIntent: previousIntent };
  }

  cancelAll(reason: string): void {
    this.clearTimer();
    if (this.pendingIntent) {
      this.deps.onIntentCancelled?.(this.pendingIntent, reason);
    }
    this.pendingIntent = null;
    this.pendingDueMs = null;
  }

  now(): SchedulerState {
    return this.buildState(this.getNowMs());
  }

  private buildState(nowMs: number): SchedulerState {
    return {
      nowMs,
      activeIntent: this.activeIntent,
      pendingIntent: this.pendingIntent,
      pendingDueMs: this.pendingDueMs,
      hasTimer: this.timer !== undefined,
      lastCompletedAtMsByKind: { ...this.lastCompletedAtMsByKind },
    };
  }

  private resolveDueAtMs(intent: RebuildIntent, nowMs: number): number {
    const resolvedDueMs = this.deps.resolveDueAtMs(intent, this.buildState(nowMs));
    if (!Number.isFinite(resolvedDueMs)) {
      return Number.POSITIVE_INFINITY;
    }
    return resolvedDueMs;
  }

  private refreshPendingSchedule(): void {
    if (!this.pendingIntent) return;
    if (this.activeIntent) {
      this.clearTimer();
      return;
    }

    const nowMs = this.getNowMs();
    const recomputedDueMs = this.resolveDueAtMs(this.pendingIntent, nowMs);
    this.pendingDueMs = recomputedDueMs;

    if (!Number.isFinite(recomputedDueMs)) {
      this.clearTimer();
      return;
    }

    const state = this.buildState(nowMs);
    const shouldExecuteImmediately = recomputedDueMs <= nowMs
      && (this.deps.shouldExecuteImmediately?.(this.pendingIntent, state) ?? true);
    if (shouldExecuteImmediately) {
      this.clearTimer();
      this.dispatchPendingIntent();
      return;
    }

    const delayMs = Math.max(0, recomputedDueMs - nowMs);
    this.armTimer(delayMs);
  }

  private armTimer(delayMs: number): void {
    this.clearTimer();
    this.timer = this.setTimeoutFn(() => {
      this.timer = undefined;
      this.dispatchPendingIntent();
    }, delayMs);
  }

  private clearTimer(): void {
    if (!this.timer) return;
    this.clearTimeoutFn(this.timer);
    this.timer = undefined;
  }

  private dispatchPendingIntent(): void {
    const intent = this.pendingIntent;
    if (!intent) return;
    if (this.activeIntent) {
      this.refreshPendingSchedule();
      return;
    }

    const nowMs = this.getNowMs();
    const dueMs = this.resolveDueAtMs(intent, nowMs);
    this.pendingDueMs = dueMs;
    if (!Number.isFinite(dueMs)) {
      this.pendingIntent = null;
      this.pendingDueMs = null;
      return;
    }
    if (Number.isFinite(dueMs) && dueMs > nowMs) {
      this.armTimer(Math.max(0, dueMs - nowMs));
      return;
    }

    this.pendingIntent = null;
    this.pendingDueMs = null;
    this.activeIntent = intent;

    Promise.resolve(this.deps.executeIntent(intent))
      .catch((error: unknown) => {
        this.deps.onIntentError?.(intent, error instanceof Error ? error : new Error(String(error)));
      })
      .finally(() => {
        this.lastCompletedAtMsByKind[intent.kind] = this.getNowMs();
        this.activeIntent = null;
        if (this.pendingIntent) {
          this.refreshPendingSchedule();
        }
      });
  }
}
