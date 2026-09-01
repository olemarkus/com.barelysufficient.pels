import { describe, expect, it } from 'vitest';
import {
  createSingleFlightLoop,
  type SingleFlightEvent,
  type SingleFlightLoop,
} from '../../lib/utils/singleFlightLoop';

type Harness = {
  loop: SingleFlightLoop<string>;
  ran: string[];
  events: SingleFlightEvent[];
  reruns: () => number;
  release: () => void;
  /**
   * Resolves when `run` is next entered. Deliberately NOT a tick count: the
   * number of microtask hops between releasing a pass and the next one starting
   * depends on how many `await`s the primitive and the consumer have, so a
   * counted flush would silently under-flush the day either gains one — and an
   * under-flushed `expect(ran).toEqual([...])` passes for the wrong reason.
   */
  nextRun: () => Promise<void>;
};

const buildHarness = (options: {
  newestWins?: boolean;
  mayContinue?: () => boolean;
  onRun?: (request: string) => void;
  onNextRequest?: () => void;
} = {}): Harness => {
  const ran: string[] = [];
  const events: SingleFlightEvent[] = [];
  let rerunCount = 0;
  // Each parked run leaves its resolver here; `release` frees the oldest, so a
  // test controls exactly when a pass finishes and overlap is deterministic.
  const parked: Array<() => void> = [];
  const runEntered: Array<() => void> = [];
  const loop = createSingleFlightLoop<string>({
    run: async (request) => {
      ran.push(request);
      options.onRun?.(request);
      runEntered.splice(0).forEach((notify) => notify());
      await new Promise<void>((resolve) => { parked.push(() => resolve()); });
    },
    nextRequest: (queued, alreadyRan) => {
      options.onNextRequest?.();
      return options.newestWins === false ? `${alreadyRan}!` : queued;
    },
    mayContinue: options.mayContinue ?? ((): boolean => true),
    onRequest: (event) => { events.push(event); },
    onRerun: () => { rerunCount += 1; },
  });
  return {
    loop,
    ran,
    events,
    reruns: () => rerunCount,
    // Releases the run that has been parked longest.
    release: () => { parked.shift()?.(); },
    nextRun: () => new Promise<void>((resolve) => { runEntered.push(() => resolve()); }),
  };
};

describe('createSingleFlightLoop', () => {
  it('runs a request synchronously when idle, and resolves when the loop drains', async () => {
    const harness = buildHarness();
    const first = harness.loop.request('a');
    // `run` is entered inside `request`, before it yields — that synchronous
    // entry is what closes the re-entry window.
    expect(harness.ran).toEqual(['a']);
    harness.release();
    await expect(first).resolves.toBe('started');
  });

  it('does not start a second run while one is in flight', async () => {
    const harness = buildHarness();
    const first = harness.loop.request('a');
    const second = harness.loop.request('b');
    // 'b' is queued, not run: still exactly one pass so far.
    expect(harness.ran).toEqual(['a']);
    const rerun = harness.nextRun();
    harness.release();
    await rerun;
    expect(harness.ran).toEqual(['a', 'b']);
    harness.release();
    await Promise.all([first, second]);
  });

  it('keeps only the newest queued request, and reports the displacement', async () => {
    const harness = buildHarness();
    const first = harness.loop.request('a');
    const second = harness.loop.request('b');
    const third = harness.loop.request('c');
    const rerun = harness.nextRun();
    harness.release();
    await rerun;
    // 'b' was displaced by 'c' before the re-run took the queue.
    expect(harness.ran).toEqual(['a', 'c']);
    expect(harness.events.map((event) => event.replacedQueued)).toEqual([false, false, true]);
    expect(harness.events.map((event) => event.join)).toEqual(['started', 'joined', 'joined']);
    expect(harness.reruns()).toBe(1);
    harness.release();
    await Promise.all([first, second, third]);
  });

  it('a mid-flight caller awaits the loop, so it observes its own request having run', async () => {
    const harness = buildHarness();
    const first = harness.loop.request('a');
    let joinedResolved = false;
    const joined = harness.loop.request('b').then((join) => {
      joinedResolved = true;
      return join;
    });
    const rerun = harness.nextRun();
    harness.release();
    await rerun;
    // The re-run for 'b' is in flight; the joiner must NOT have resolved yet.
    expect(harness.ran).toEqual(['a', 'b']);
    expect(joinedResolved).toBe(false);
    harness.release();
    await expect(joined).resolves.toBe('joined');
    await first;
  });

  it('a SYNCHRONOUSLY re-entrant caller queues and returns rather than starting a second run', async () => {
    const reentrant: Array<Promise<string>> = [];
    // `harness` is only read from inside `onRun`, which cannot fire until the
    // test calls `request` below — by which point the binding is initialized.
    const harness: Harness = buildHarness({
      onRun: (request) => {
        // Re-enter before the run has yielded once: the loop promise cannot
        // exist yet, so this must not be mistaken for an idle loop.
        if (request === 'a') reentrant.push(harness.loop.request('reentrant'));
      },
    });
    const first = harness.loop.request('a');
    // Exactly one run started, despite the re-entrant request.
    expect(harness.ran).toEqual(['a']);
    await expect(reentrant[0]).resolves.toBe('queued');
    const rerun = harness.nextRun();
    harness.release();
    await rerun;
    // The re-entrant request was still honoured, as the queued re-run.
    expect(harness.ran).toEqual(['a', 'reentrant']);
    harness.release();
    await first;
  });

  it('a synchronously re-entrant caller queues on a QUEUED RE-RUN too, rather than deadlocking', async () => {
    const reentrant: Array<Promise<string>> = [];
    const harness: Harness = buildHarness({
      onRun: (request) => {
        // Re-enter from the SECOND pass, where the loop promise already exists.
        // Awaiting it here would await a drain that cannot settle until this
        // very run returns.
        if (request === 'b') reentrant.push(harness.loop.request('from-rerun'));
      },
    });
    const first = harness.loop.request('a');
    const second = harness.loop.request('b');
    const rerun = harness.nextRun();
    harness.release();
    await rerun;
    expect(harness.ran).toEqual(['a', 'b']);
    await expect(reentrant[0]).resolves.toBe('queued');
    const thirdRun = harness.nextRun();
    harness.release();
    await thirdRun;
    // The re-entrant request was honoured as the next queued re-run.
    expect(harness.ran).toEqual(['a', 'b', 'from-rerun']);
    harness.release();
    await Promise.all([first, second]);
  });

  it('drops the queued re-run, and never consults the re-run policy, when the consumer may not continue', async () => {
    let alive = true;
    let nextRequestCalls = 0;
    const harness = buildHarness({
      mayContinue: () => alive,
      onNextRequest: () => { nextRequestCalls += 1; },
    });
    const first = harness.loop.request('a');
    const second = harness.loop.request('b');
    alive = false;
    harness.release();
    await Promise.all([first, second]);
    expect(harness.ran).toEqual(['a']);
    expect(harness.reruns()).toBe(0);
    expect(nextRequestCalls).toBe(0);
  });

  it('lets a consumer re-run its own request instead of the queued one', async () => {
    const harness = buildHarness({ newestWins: false });
    const first = harness.loop.request('a');
    const second = harness.loop.request('b');
    const rerun = harness.nextRun();
    harness.release();
    await rerun;
    // 'b' asked for a re-run but the consumer's policy repeats its own request.
    expect(harness.ran).toEqual(['a', 'a!']);
    harness.release();
    await Promise.all([first, second]);
  });

  it('rejects the initiator AND every joiner when a run throws, and drops the queued re-run', async () => {
    const ran: string[] = [];
    const events: SingleFlightEvent[] = [];
    let nextRequestCalls = 0;
    const loop = createSingleFlightLoop<string>({
      run: async (request) => {
        ran.push(request);
        await Promise.resolve();
        throw new Error('run failed');
      },
      nextRequest: (queued) => { nextRequestCalls += 1; return queued; },
      mayContinue: () => true,
      onRequest: (event) => { events.push(event); },
      onRerun: () => {},
    });
    const initiator = loop.request('a');
    const joiner = loop.request('b');
    const displacing = loop.request('c');
    await expect(initiator).rejects.toThrow('run failed');
    await expect(joiner).rejects.toThrow('run failed');
    await expect(displacing).rejects.toThrow('run failed');
    // The queued request is dropped rather than re-run, as both hand-rolled
    // loops did: one pass, and the re-run policy is never consulted.
    expect(ran).toEqual(['a']);
    expect(nextRequestCalls).toBe(0);
    expect(events.map((event) => event.join)).toEqual(['started', 'joined', 'joined']);
  });

  it('releases its state when a run throws, so the next request starts cleanly', async () => {
    const ran: string[] = [];
    const loop = createSingleFlightLoop<string>({
      run: async (request) => {
        ran.push(request);
        await Promise.resolve();
        throw new Error('run failed');
      },
      nextRequest: (queued) => queued,
      mayContinue: () => true,
      onRequest: () => {},
      onRerun: () => {},
    });
    await expect(loop.request('a')).rejects.toThrow('run failed');
    await expect(loop.request('b')).rejects.toThrow('run failed');
    expect(ran).toEqual(['a', 'b']);
  });
});
