/**
 * One run at a time, with exactly one queued re-run.
 *
 * Two call sites grew this pattern independently — the whole-home sample
 * pipeline and the device-snapshot refresh — and each spelled it differently.
 * (`setup/appNativeWiring.ts` looks like a third, but it is the degenerate
 * drop-only variant: an overlapping run is discarded rather than queued,
 * deliberately, so it does NOT adopt this primitive.) The shape the two share:
 *
 * - a request while idle starts a run;
 * - a request arriving mid-run does NOT start a second one; it queues, and only
 *   ever one request is queued (a later arrival replaces the earlier);
 * - when a run finishes with something queued, the loop takes another pass
 *   rather than returning;
 * - a caller that arrives mid-run waits for the loop to drain, so it observes
 *   the state its own request contributed to.
 *
 * **The synchronous re-entry window is modelled here on purpose.** Every hand
 * -rolled version had the same hole: the loop promise can only be assigned
 * AFTER the async function has been called, so a caller re-entering
 * synchronously — before the first `await` inside the run — sees no promise and
 * concludes the loop is idle. `appSnapshotHelpers` noticed and fell back to
 * queue-and-return; the sample pipeline did not, and would have started a
 * second concurrent loop. Here `running` is set synchronously, before `run` is
 * invoked, so re-entry is always detected, and a separate flag brackets each
 * run's synchronous prologue — on EVERY pass, not just the first — so a
 * re-entrant caller gets `queued` rather than awaiting a drain that cannot
 * settle until the run it re-entered from returns. Its request is still
 * honoured, as the queued re-run.
 *
 * **`running` also clears earlier than the hand-rolled versions did**, inside
 * the drain's own `finally` rather than one microtask later in the caller's.
 * Both old copies had a window where the loop had settled but still advertised
 * itself as in flight, and a caller landing there awaited an already-resolved
 * promise and returned having done nothing — the snapshot refresh it asked for
 * was silently dropped. Here that window does not exist, so such a caller
 * starts a real run. Expect marginally more refreshes and fewer coalesce
 * events than before; both are the correct counts.
 *
 * This lives in `lib/utils` because it names no domain concept and must be
 * reachable from consumers in different peer modules that may not import each
 * other. It holds no timers and starts nothing on its own.
 */

/** How one `request` call related to the run that ended up serving it. */
export type SingleFlightJoin = 'started' | 'joined' | 'queued';

export type SingleFlightEvent = {
  join: SingleFlightJoin;
  /** True when this request displaced an already-queued one. */
  replacedQueued: boolean;
};

export type SingleFlightLoop<TRequest> = {
  /**
   * Run `request`, or fold it into the run already in flight. Resolves once the
   * loop that serves it has fully drained — except for a synchronous re-entrant
   * caller, which resolves immediately with `queued`.
   */
  request: (request: TRequest) => Promise<SingleFlightJoin>;
};

export type SingleFlightLoopDeps<TRequest> = {
  /** One pass. The loop never calls this concurrently with itself. */
  run: (request: TRequest) => Promise<void>;
  /**
   * What the queued re-run should execute, given the queued request and the one
   * that just ran. Newest-wins is `(queued) => queued`; a consumer that treats a
   * queued request as "do that again" returns a variant of `ran` instead.
   */
  nextRequest: (queued: TRequest, ran: TRequest) => TRequest;
  /**
   * Whether the loop may take another pass. Checked only when something is
   * queued, so a consumer that is shutting down drops the re-run rather than
   * running it against a torn-down collaborator.
   */
  mayContinue: () => boolean;
  /** Observability for the coalescing decision. Must not throw. */
  onRequest: (event: SingleFlightEvent) => void;
  /** A queued re-run is about to execute. Must not throw. */
  onRerun: () => void;
};

export const createSingleFlightLoop = <TRequest>(
  deps: SingleFlightLoopDeps<TRequest>,
): SingleFlightLoop<TRequest> => {
  // Set synchronously at the request edge; this is what closes the re-entry
  // window that `loop` alone cannot.
  let running = false;
  // True only while a `run` call is executing its SYNCHRONOUS prologue — the
  // stretch before it first awaits. `loop === undefined` is not a substitute:
  // it identifies the first pass's prologue and nothing else, so a re-entrant
  // caller during a queued RE-RUN would await a drain that cannot settle until
  // the very `run` it re-entered from returns. That is a deadlock, and both
  // hand-rolled versions had it.
  let insidePrologue = false;
  let loop: Promise<void> | undefined;
  let queued: { request: TRequest } | undefined;
  // Read through a call so TypeScript does not narrow `queued` to `never` across
  // the `await` below: `deps.run` is what assigns it, and the compiler cannot
  // see that from here.
  const peekQueued = (): { request: TRequest } | undefined => queued;

  const drain = async (initial: TRequest): Promise<void> => {
    let current = initial;
    try {
      for (;;) {
        // Cleared BEFORE the pass, so a request arriving during it queues a
        // genuine re-run rather than being swallowed by the pass it missed.
        queued = undefined;
        insidePrologue = true;
        // `run` executes synchronously up to its first `await`, then hands back
        // a promise; the flag brackets exactly that stretch.
        const pass = deps.run(current);
        insidePrologue = false;
        await pass;
        const pending = peekQueued();
        if (pending === undefined || !deps.mayContinue()) return;
        deps.onRerun();
        current = deps.nextRequest(pending.request, current);
      }
    } finally {
      insidePrologue = false;
      running = false;
      loop = undefined;
      queued = undefined;
    }
  };

  const request = async (next: TRequest): Promise<SingleFlightJoin> => {
    if (running) {
      const replacedQueued = peekQueued() !== undefined;
      queued = { request: next };
      // Inside a run's own synchronous prologue, awaiting would be awaiting
      // ourselves — on any pass, not just the first.
      const join: SingleFlightJoin = insidePrologue || loop === undefined ? 'queued' : 'joined';
      deps.onRequest({ join, replacedQueued });
      if (join === 'joined' && loop !== undefined) await loop;
      return join;
    }
    running = true;
    deps.onRequest({ join: 'started', replacedQueued: false });
    const pending = drain(next);
    loop = pending;
    await pending;
    return 'started';
  };

  return { request };
};
