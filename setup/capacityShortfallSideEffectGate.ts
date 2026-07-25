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

export type CapacityShortfallSideEffectGate = {
  onShortfall: (deficitKw: number) => Promise<void>;
  onShortfallCleared: () => Promise<void>;
  /** Bind an already-deferred transition to the prepared sample now starting. */
  holdDeferredUntilPreparedApply: () => void;
  /**
   * Apply the last transition deferred by a temporary authority fence.
   * False means authority is still closed; failures reject and retain it.
   */
  flush: () => Promise<boolean>;
  /**
   * Apply a held transition after the caller proved its prepared plan current.
   * Authority closure or apply failure retains the hold for the next prepared
   * attempt; generic timer flushes can never consume it.
   */
  flushAfterPreparedApply: () => Promise<boolean>;
};

/**
 * CapacityGuard latches enter/clear before invoking its callbacks. A temporary
 * ownership fence therefore cannot merely drop a callback: the guard will not
 * emit it again after reopening. Retain the latest semantic transition and
 * flush it once the prepared generation is authoritative. Teardown/source
 * invalidation is permanent for this runtime, so those transitions are dropped.
 */
export const createCapacityShortfallSideEffectGate = (params: {
  isDiscarded: () => boolean;
  isTemporarilyFenced: () => boolean;
  shouldHoldDeferredForPreparedApply?: () => boolean;
  /** Request one bounded retry after a temporary fence or failed apply. */
  scheduleRetry?: () => void;
  applyShortfall: (deficitKw: number) => Promise<void>;
  applyClear: () => Promise<void>;
}): CapacityShortfallSideEffectGate => {
  let deferred: DeferredShortfallTransition | null = null;
  const flushDeferred = async (allowPrepared: boolean): Promise<boolean> => {
    if (params.isDiscarded()) {
      deferred = null;
      return true;
    }
    if (params.isTemporarilyFenced()) {
      params.scheduleRetry?.();
      return false;
    }
    const entry = deferred;
    if (entry === null) return true;
    if (entry.heldForPreparedApply && !allowPrepared) {
      params.scheduleRetry?.();
      return false;
    }
    try {
      const { transition } = entry;
      if (transition.state === 'shortfall') {
        await params.applyShortfall(transition.deficitKw);
      } else {
        await params.applyClear();
      }
    } catch (error) {
      params.scheduleRetry?.();
      throw error;
    }
    if (deferred === entry) deferred = null;
    return true;
  };
  const flush = (): Promise<boolean> => flushDeferred(false);
  const deferAndFlush = async (transition: ShortfallTransition): Promise<void> => {
    deferred = {
      transition,
      heldForPreparedApply: params.shouldHoldDeferredForPreparedApply?.() === true,
    };
    await flush();
  };
  return {
    onShortfall: async (deficitKw) => deferAndFlush({ state: 'shortfall', deficitKw }),
    onShortfallCleared: async () => deferAndFlush({ state: 'clear' }),
    holdDeferredUntilPreparedApply: () => {
      if (deferred) deferred = { ...deferred, heldForPreparedApply: true };
    },
    flush,
    flushAfterPreparedApply: () => flushDeferred(true),
  };
};
