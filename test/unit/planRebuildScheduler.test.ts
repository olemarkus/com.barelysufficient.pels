import { PlanRebuildScheduler, type RebuildIntent } from '../../lib/plan/rebuildScheduler/scheduler';

type TimerHandle = { id: number };

const signal: RebuildIntent = { kind: 'signal', reason: 'headroom_tight' };
const laterSignal: RebuildIntent = { kind: 'signal', reason: 'power_delta' };
const hardCap: RebuildIntent = { kind: 'hardCap', reason: 'hard_cap_breach' };

const createDeferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
};

const flushMicrotasks = async (): Promise<void> => {
  for (let i = 0; i < 4; i += 1) await Promise.resolve();
};

/**
 * A scheduler on a hand-driven clock and timer table. `dueAtByKind` stands in
 * for the throttle: a spec sets the absolute time each kind may run from, and
 * anything already past runs at once.
 */
const createHarness = (execute: (intent: RebuildIntent) => Promise<void> = async () => undefined) => {
  let nowMs = 0;
  let nextId = 1;
  const timers = new Map<number, { dueMs: number; callback: () => void }>();
  const dueAtByKind: Record<RebuildIntent['kind'], number> = { hardCap: 0, signal: 0 };
  const executed: RebuildIntent[] = [];
  const dropped: Array<{ dropped: RebuildIntent; kept: RebuildIntent }> = [];
  const replaced: Array<{ previous: RebuildIntent; next: RebuildIntent }> = [];
  const cancelled: Array<{ intent: RebuildIntent; reason: string }> = [];
  const errors: Array<{ intent: RebuildIntent; error: Error }> = [];

  const scheduler = new PlanRebuildScheduler({
    getNowMs: () => nowMs,
    setTimeoutFn: (callback, delayMs) => {
      const handle = { id: nextId++ };
      timers.set(handle.id, { dueMs: nowMs + delayMs, callback });
      return handle as TimerHandle & ReturnType<typeof setTimeout>;
    },
    clearTimeoutFn: (handle) => {
      timers.delete((handle as unknown as TimerHandle).id);
    },
    resolveDueAtMs: (intent, atMs) => Math.max(atMs, dueAtByKind[intent.kind]),
    executeIntent: async (intent) => {
      executed.push(intent);
      await execute(intent);
    },
    onIntentDropped: (droppedIntent, kept) => dropped.push({ dropped: droppedIntent, kept }),
    onPendingIntentReplaced: (previous, next) => replaced.push({ previous, next }),
    onIntentCancelled: (intent, reason) => cancelled.push({ intent, reason }),
    onIntentError: (intent, error) => errors.push({ intent, error }),
  });

  const advance = async (deltaMs: number): Promise<void> => {
    nowMs += deltaMs;
    for (;;) {
      const due = [...timers.entries()]
        .sort((left, right) => left[1].dueMs - right[1].dueMs)
        .find(([, timer]) => timer.dueMs <= nowMs);
      if (!due) break;
      timers.delete(due[0]);
      due[1].callback();
      await flushMicrotasks();
    }
  };

  return { scheduler, timers, dueAtByKind, executed, dropped, replaced, cancelled, errors, advance };
};

describe('PlanRebuildScheduler', () => {
  it('runs an intent that is already due at once, arming no timer', () => {
    const harness = createHarness();

    harness.scheduler.request(signal);

    expect(harness.executed).toEqual([signal]);
    expect(harness.timers.size).toBe(0);
  });

  it('replaces a pending signal with a hard-cap breach and runs the breach instead', () => {
    const harness = createHarness();
    harness.dueAtByKind.signal = 2_000;

    harness.scheduler.request(signal);
    expect(harness.timers.size).toBe(1);

    harness.scheduler.request(hardCap);

    expect(harness.replaced).toEqual([{ previous: signal, next: hardCap }]);
    expect(harness.executed).toEqual([hardCap]);
    expect(harness.timers.size).toBe(0);
  });

  it('drops a signal that arrives behind a pending hard-cap breach', () => {
    const harness = createHarness();
    harness.dueAtByKind.hardCap = 15_000;

    harness.scheduler.request(hardCap);
    harness.scheduler.request(signal);

    expect(harness.dropped).toEqual([{ dropped: signal, kept: hardCap }]);
    expect(harness.executed).toEqual([]);
  });

  it('keeps the latest reason within a kind and runs it when due', async () => {
    const harness = createHarness();
    harness.dueAtByKind.signal = 2_000;

    harness.scheduler.request(signal);
    harness.scheduler.request(laterSignal);
    expect(harness.replaced).toEqual([{ previous: signal, next: laterSignal }]);

    await harness.advance(2_000);

    expect(harness.executed).toEqual([laterSignal]);
  });

  it('asks for the due time again when its timer fires, and waits if it moved', async () => {
    const harness = createHarness();
    harness.dueAtByKind.signal = 2_000;

    harness.scheduler.request(signal);
    // The throttle moved the due time on (a floor it learned meanwhile), so the
    // fire re-arms rather than running early.
    harness.dueAtByKind.signal = 4_000;
    await harness.advance(2_000);
    expect(harness.executed).toEqual([]);
    expect(harness.timers.size).toBe(1);

    await harness.advance(2_000);
    expect(harness.executed).toEqual([signal]);
  });

  it('holds an intent behind an active rebuild and runs it once that ends', async () => {
    const deferred = createDeferred();
    const harness = createHarness((intent) => (intent === hardCap ? deferred.promise : Promise.resolve()));

    harness.scheduler.request(hardCap);
    harness.scheduler.request(signal);
    expect(harness.executed).toEqual([hardCap]);
    expect(harness.timers.size).toBe(0);

    deferred.resolve();
    await flushMicrotasks();

    expect(harness.executed).toEqual([hardCap, signal]);
  });

  it('reports a rebuild that threw and keeps scheduling', async () => {
    const harness = createHarness((intent) => (
      intent === hardCap ? Promise.reject(new Error('boom')) : Promise.resolve()
    ));

    harness.scheduler.request(hardCap);
    await flushMicrotasks();
    harness.scheduler.request(signal);

    expect(harness.errors).toEqual([{ intent: hardCap, error: new Error('boom') }]);
    expect(harness.executed).toEqual([hardCap, signal]);
  });

  it('cancels the pending timer and reports the cancelled intent', () => {
    const harness = createHarness();
    harness.dueAtByKind.signal = 2_000;

    harness.scheduler.request(signal);
    harness.scheduler.cancelAll('app_uninit');

    expect(harness.timers.size).toBe(0);
    expect(harness.cancelled).toEqual([{ intent: signal, reason: 'app_uninit' }]);
  });
});
