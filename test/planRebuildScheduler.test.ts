import { PlanRebuildScheduler, type RebuildIntent } from '../lib/app/planRebuildScheduler';

type TimerHandle = { id: number };

const createHarness = () => {
  let nowMs = 0;
  let nextId = 1;
  const timers = new Map<number, { dueMs: number; callback: () => void }>();

  const scheduler = new PlanRebuildScheduler({
    getNowMs: () => nowMs,
    setTimeoutFn: (callback, delayMs) => {
      const handle = { id: nextId++ };
      timers.set(handle.id, { dueMs: nowMs + delayMs, callback });
      return handle as TimerHandle & ReturnType<typeof setTimeout>;
    },
    clearTimeoutFn: (handle) => {
      timers.delete((handle as TimerHandle).id);
    },
    resolveDueAtMs: (intent, state) => {
      if (intent.kind === 'flow') return state.nowMs;
      if (intent.kind === 'signal') return state.nowMs;
      if (intent.kind === 'hardCap') return state.nowMs;
      return state.pendingDueMs ?? (state.nowMs + 30_000);
    },
    executeIntent: async (intent) => {
      executed.push(intent);
    },
    shouldExecuteImmediately: (intent) => intent.kind !== 'flow',
    onIntentDropped: (dropped, kept) => droppedEvents.push({ dropped, kept }),
    onPendingIntentReplaced: (previous, next) => replacedEvents.push({ previous, next }),
    onIntentCancelled: (intent, reason) => cancelledEvents.push({ intent, reason }),
  });

  const executed: RebuildIntent[] = [];
  const droppedEvents: Array<{ dropped: RebuildIntent; kept: RebuildIntent }> = [];
  const replacedEvents: Array<{ previous: RebuildIntent; next: RebuildIntent }> = [];
  const cancelledEvents: Array<{ intent: RebuildIntent; reason: string }> = [];

  const advance = async (deltaMs: number): Promise<void> => {
    nowMs += deltaMs;
    while (true) {
      const nextTimerEntry = [...timers.entries()]
        .sort((left, right) => left[1].dueMs - right[1].dueMs)
        .find(([, timer]) => timer.dueMs <= nowMs);
      if (!nextTimerEntry) break;
      timers.delete(nextTimerEntry[0]);
      nextTimerEntry[1].callback();
      await Promise.resolve();
      await Promise.resolve();
    }
  };

  return {
    scheduler,
    executed,
    droppedEvents,
    replacedEvents,
    cancelledEvents,
    timers,
    advance,
    getNowMs: () => nowMs,
  };
};

const createDeferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
};

describe('PlanRebuildScheduler', () => {
  it('coalesces flow, signal, and snapshot requests down to the highest-priority reason', async () => {
    const harness = createHarness();

    harness.scheduler.request({ kind: 'flow', reason: 'flow_card:first' });
    harness.scheduler.request({ kind: 'signal', reason: 'headroom_tight' });
    harness.scheduler.request({ kind: 'snapshot', reason: 'meta_only' });

    expect(harness.executed).toEqual([{ kind: 'signal', reason: 'headroom_tight' }]);
    expect(harness.replacedEvents).toEqual([{
      previous: { kind: 'flow', reason: 'flow_card:first' },
      next: { kind: 'signal', reason: 'headroom_tight' },
    }]);
    expect(harness.scheduler.now().pendingIntent).toEqual({ kind: 'snapshot', reason: 'meta_only' });
    expect(harness.droppedEvents).toEqual([]);
    expect(harness.timers.size).toBe(0);

    await harness.advance(100);
    expect(harness.executed).toEqual([{ kind: 'signal', reason: 'headroom_tight' }]);
  });

  it('keeps exactly one timer armed while higher-priority intents replace lower ones', () => {
    const harness = createHarness();

    harness.scheduler.request({ kind: 'snapshot', reason: 'meta_only' });
    expect(harness.timers.size).toBe(1);

    harness.scheduler.request({ kind: 'flow', reason: 'flow_card:first' });
    expect(harness.timers.size).toBe(1);

    harness.scheduler.request({ kind: 'snapshot', reason: 'meta_only_ignored' });
    expect(harness.timers.size).toBe(1);
  });

  it('coalesces within a kind and keeps the latest reason', async () => {
    const harness = createHarness();

    harness.scheduler.request({ kind: 'flow', reason: 'flow_card:first' });
    harness.scheduler.request({ kind: 'flow', reason: 'flow_card:latest' });

    expect(harness.replacedEvents).toEqual([{
      previous: { kind: 'flow', reason: 'flow_card:first' },
      next: { kind: 'flow', reason: 'flow_card:latest' },
    }]);

    await harness.advance(0);

    expect(harness.executed).toEqual([{ kind: 'flow', reason: 'flow_card:latest' }]);
  });

  it('cancels the pending timer and reports the cancelled intent', () => {
    const harness = createHarness();

    harness.scheduler.request({ kind: 'snapshot', reason: 'meta_only' });
    expect(harness.timers.size).toBe(1);

    harness.scheduler.cancelAll('app_uninit');

    expect(harness.timers.size).toBe(0);
    expect(harness.cancelledEvents).toEqual([{
      intent: { kind: 'snapshot', reason: 'meta_only' },
      reason: 'app_uninit',
    }]);
  });

  it('tracks time from the injected monotonic clock rather than wall-clock dates', async () => {
    const harness = createHarness();
    const dateNowSpy = vi.spyOn(Date, 'now').mockImplementation(() => 123456789);

    harness.scheduler.request({ kind: 'snapshot', reason: 'meta_only' });
    expect(harness.scheduler.now().pendingDueMs).toBe(harness.getNowMs() + 30_000);

    await harness.advance(30_000);

    expect(harness.executed).toEqual([{ kind: 'snapshot', reason: 'meta_only' }]);
    dateNowSpy.mockRestore();
  });

  it('queues a deferred snapshot intent behind an active rebuild', async () => {
    const deferred = createDeferred();
    let nowMs = 0;
    let nextId = 1;
    const timers = new Map<number, { dueMs: number; callback: () => void }>();
    const executed: RebuildIntent[] = [];
    const scheduler = new PlanRebuildScheduler({
      getNowMs: () => nowMs,
      setTimeoutFn: (callback, delayMs) => {
        const handle = { id: nextId++ };
        timers.set(handle.id, { dueMs: nowMs + delayMs, callback });
        return handle as TimerHandle & ReturnType<typeof setTimeout>;
      },
      clearTimeoutFn: (handle) => {
        timers.delete((handle as TimerHandle).id);
      },
      resolveDueAtMs: (intent, state) => {
        if (intent.kind === 'snapshot') return state.pendingDueMs ?? (state.nowMs + 30_000);
        return state.nowMs;
      },
      executeIntent: async (intent) => {
        executed.push(intent);
        if (intent.kind === 'hardCap') {
          await deferred.promise;
        }
      },
      shouldExecuteImmediately: (intent) => intent.kind !== 'flow',
    });

    scheduler.request({ kind: 'hardCap', reason: 'limit_exceeded' });
    expect(executed).toEqual([{ kind: 'hardCap', reason: 'limit_exceeded' }]);

    scheduler.request({ kind: 'snapshot', reason: 'meta_only' });

    expect(scheduler.now().pendingIntent).toEqual({ kind: 'snapshot', reason: 'meta_only' });
    expect(timers.size).toBe(0);

    deferred.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(timers.size).toBe(1);
    const [timer] = [...timers.values()];
    timers.clear();
    nowMs = 30_000;
    timer.callback();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(executed).toEqual([
      { kind: 'hardCap', reason: 'limit_exceeded' },
      { kind: 'snapshot', reason: 'meta_only' },
    ]);
  });

  it('queues a higher-priority intent behind an active lower-priority one without running concurrently', async () => {
    const deferred = createDeferred();
    const nowMs = 0;
    let nextId = 1;
    const timers = new Map<number, { dueMs: number; callback: () => void }>();
    const executed: RebuildIntent[] = [];
    const scheduler = new PlanRebuildScheduler({
      getNowMs: () => nowMs,
      setTimeoutFn: (callback, delayMs) => {
        const handle = { id: nextId++ };
        timers.set(handle.id, { dueMs: nowMs + delayMs, callback });
        return handle as TimerHandle & ReturnType<typeof setTimeout>;
      },
      clearTimeoutFn: (handle) => {
        timers.delete((handle as TimerHandle).id);
      },
      resolveDueAtMs: (_intent, state) => state.nowMs,
      executeIntent: async (intent) => {
        executed.push(intent);
        if (intent.kind === 'flow') {
          await deferred.promise;
        }
      },
      shouldExecuteImmediately: (intent) => intent.kind !== 'flow',
    });

    scheduler.request({ kind: 'flow', reason: 'flow_card:first' });
    expect(timers.size).toBe(1);

    const timer = [...timers.values()][0];
    timers.clear();
    timer.callback();
    await Promise.resolve();

    expect(executed).toEqual([{ kind: 'flow', reason: 'flow_card:first' }]);
    expect(scheduler.now().activeIntent).toEqual({ kind: 'flow', reason: 'flow_card:first' });

    scheduler.request({ kind: 'signal', reason: 'headroom_tight' });
    expect(executed).toEqual([{ kind: 'flow', reason: 'flow_card:first' }]);
    expect(scheduler.now().pendingIntent).toEqual({ kind: 'signal', reason: 'headroom_tight' });
    expect(timers.size).toBe(0);

    deferred.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(executed).toEqual([
      { kind: 'flow', reason: 'flow_card:first' },
      { kind: 'signal', reason: 'headroom_tight' },
    ]);
  });

  it('clears a pending intent when its recomputed due time becomes non-finite', async () => {
    let allowSnapshot = true;
    const harness = createHarness();
    const scheduler = new PlanRebuildScheduler({
      getNowMs: harness.getNowMs,
      setTimeoutFn: (callback, delayMs) => {
        const handle = { id: harness.timers.size + 1 };
        harness.timers.set(handle.id, { dueMs: harness.getNowMs() + delayMs, callback });
        return handle as TimerHandle & ReturnType<typeof setTimeout>;
      },
      clearTimeoutFn: (handle) => {
        harness.timers.delete((handle as TimerHandle).id);
      },
      resolveDueAtMs: (_intent, state) => (allowSnapshot ? state.nowMs + 100 : Number.POSITIVE_INFINITY),
      executeIntent: async (intent) => {
        harness.executed.push(intent);
      },
    });

    scheduler.request({ kind: 'snapshot', reason: 'meta_only' });
    expect(harness.timers.size).toBe(1);

    allowSnapshot = false;
    await harness.advance(100);

    expect(harness.executed).toEqual([]);
    expect(scheduler.now().pendingIntent).toBeNull();
    expect(scheduler.now().pendingDueMs).toBeNull();
  });
});
