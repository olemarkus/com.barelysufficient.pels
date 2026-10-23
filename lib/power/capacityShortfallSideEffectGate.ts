import type { TimerRegistry } from '../utils/timerRegistry';

/** How long a transition held by a temporary fence or a failed apply waits before it is offered again. */
export const SHORTFALL_SIDE_EFFECT_RETRY_MS = 1_000;

type ShortfallTransition =
  | { state: 'shortfall'; deficitKw: number }
  | { state: 'clear' };

type DeferredShortfallTransition = {
  transition: ShortfallTransition;
  /**
   * The transition was observed while a prepared sample plan owned the
   * actuator fence. If that plan is superseded, wait until the newer sample has
   * fully updated CapacityGuard before deciding whether this remains the latest
   * semantic transition.
   */
  heldForPreparedApply: boolean;
};

/**
 * What a shortfall transition does once it may act: the home's plan service
 * enters or leaves its shortfall handling. Declared here so the gate needs no
 * plan import; `PlanService` satisfies it as it stands.
 */
export type ShortfallSideEffects = {
  handleShortfall(deficitKw: number): Promise<void>;
  handleShortfallCleared(): Promise<void>;
};

/**
 * CapacityGuard latches enter/clear before invoking its callbacks. A temporary
 * ownership fence therefore cannot merely drop a callback: the guard will not
 * emit it again after reopening. Retain the latest semantic transition and
 * flush it once the prepared generation is authoritative. Teardown/source
 * invalidation is permanent for this runtime, so those transitions are dropped.
 *
 * It owns the one bounded retry too: a transition held by a temporary fence or
 * a failed apply is offered again after {@link SHORTFALL_SIDE_EFFECT_RETRY_MS}
 * under `retryTimerKey`, which home teardown clears by name.
 *
 * - `isDiscarded` is permanent for this runtime (torn down, or the meter source's
 *   epoch invalidated).
 * - `isTemporarilyFenced` is any fence that can reopen, prepared apply included.
 * - `isPreparedReconcileActive` is one prepared plan owning the actuator; a
 *   transition observed under it may be consumed only by that plan's own flush.
 */
export class CapacityShortfallSideEffectGate {
  private deferred: DeferredShortfallTransition | null = null;

  constructor(
    private readonly timers: TimerRegistry,
    private readonly retryTimerKey: string,
    private readonly isDiscarded: () => boolean,
    private readonly isTemporarilyFenced: () => boolean,
    private readonly isPreparedReconcileActive: () => boolean,
    private readonly getSideEffects: () => ShortfallSideEffects,
    /** Said when a retried flush fails; the transition stays held for the next. */
    private readonly onRetryFailed: (error: unknown) => void,
  ) {}

  // Arrow properties: CapacityGuard is handed these unbound.
  readonly onShortfall = async (deficitKw: number): Promise<void> => (
    this.deferAndFlush({ state: 'shortfall', deficitKw })
  );

  readonly onShortfallCleared = async (): Promise<void> => this.deferAndFlush({ state: 'clear' });

  /** Bind an already-deferred transition to the prepared sample now starting. */
  readonly holdDeferredUntilPreparedApply = (): void => {
    if (this.deferred) this.deferred = { ...this.deferred, heldForPreparedApply: true };
  };

  /**
   * Apply the last transition deferred by a temporary authority fence.
   * False means authority is still closed; failures reject and retain it.
   */
  readonly flush = (): Promise<boolean> => this.flushDeferred(false);

  /**
   * Apply a held transition after the caller proved its prepared plan current.
   * Authority closure or apply failure retains the hold for the next prepared
   * attempt; generic timer flushes can never consume it.
   */
  readonly flushAfterPreparedApply = (): Promise<boolean> => this.flushDeferred(true);

  private async deferAndFlush(transition: ShortfallTransition): Promise<void> {
    this.deferred = { transition, heldForPreparedApply: this.isPreparedReconcileActive() };
    await this.flush();
  }

  private async flushDeferred(allowPrepared: boolean): Promise<boolean> {
    if (this.isDiscarded()) {
      this.deferred = null;
      return true;
    }
    if (this.isTemporarilyFenced()) {
      this.scheduleRetry();
      return false;
    }
    const entry = this.deferred;
    if (entry === null) return true;
    if (entry.heldForPreparedApply && !allowPrepared) {
      this.scheduleRetry();
      return false;
    }
    try {
      const { transition } = entry;
      const sideEffects = this.getSideEffects();
      if (transition.state === 'shortfall') {
        await sideEffects.handleShortfall(transition.deficitKw);
      } else {
        await sideEffects.handleShortfallCleared();
      }
    } catch (error) {
      this.scheduleRetry();
      throw error;
    }
    if (this.deferred === entry) this.deferred = null;
    return true;
  }

  private scheduleRetry(): void {
    if (this.isDiscarded() || this.timers.has(this.retryTimerKey)) return;
    this.timers.registerTimeout(this.retryTimerKey, setTimeout(() => {
      this.timers.clear(this.retryTimerKey);
      void this.flush().catch((error: unknown) => this.onRetryFailed(error));
    }, SHORTFALL_SIDE_EFFECT_RETRY_MS));
  }
}
