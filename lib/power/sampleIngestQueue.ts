import { incPerfCounter } from '../utils/perfCounters';
import { createSingleFlightLoop } from '../utils/singleFlightLoop';

/**
 * One whole-home sample ingest at a time, and the ledger that says whose sample
 * the tracker is now serving.
 *
 * Two questions live here, and they are both about samples rather than about
 * planning:
 *
 * - **Coalescing.** Readings arrive faster than an ingest completes (a 10 s poll
 *   against plan work that can take over a second), so a request arriving
 *   mid-ingest queues rather than starting a second pass, and the newest queued
 *   request wins — an older reading has nothing to add once a newer one exists.
 *   `lib/utils/singleFlightLoop.ts` does the coalescing; this adds the sample
 *   vocabulary on top.
 * - **Admission.** A caller needs to know whether ITS watts are the ones the
 *   tracker ended up serving, because publishing meter authority or advancing
 *   flow freshness on superseded watts attributes them to the wrong reading.
 *   The revision is taken at the synchronous request edge, before a coalesced
 *   sample can wait on plan work.
 *
 * The queue never sees what a run does. `run` is injected, which is what lets
 * this live in `lib/power` at all: the ingest it drives reaches into `lib/plan`
 * and `lib/objectives`, and `lib/power` sits under both.
 */

/** Whether the caller's own sample is the one the tracker now serves. */
export type SampleAdmission =
  | { state: 'admitted'; revision: number }
  | { state: 'superseded'; revision: number; latestRevision: number };

/** Whether every requested sample has finished, or one is still in flight. */
export type StableSampleRevision =
  | { state: 'stable'; revision: number }
  | { state: 'pending' };

export type SampleIngestQueue<TRequest> = {
  /**
   * Take a revision, build the request against it, and run or queue it.
   *
   * Resolves once the loop serving it has drained — except for a caller that
   * re-enters SYNCHRONOUSLY from inside a run, which resolves immediately
   * (`createSingleFlightLoop` answers it `queued`, because awaiting there would
   * be awaiting its own frame). Its request is still honoured as the re-run;
   * what it cannot do is read a verdict that accounts for it, so it sees
   * `superseded` — see `resolveAdmission`.
   */
  submit: (buildRequest: (revision: number) => TRequest) => Promise<SampleAdmission>;
  getStableRevision: () => StableSampleRevision;
};

export type SampleIngestQueueDeps<TRequest> = {
  /** One ingest. Never called concurrently with itself. */
  run: (request: TRequest) => Promise<void>;
};

type QueuedSample<TRequest> = {
  revision: number;
  request: TRequest;
};

export const createSampleIngestQueue = <TRequest>(
  deps: SampleIngestQueueDeps<TRequest>,
): SampleIngestQueue<TRequest> => {
  let requestedRevision = 0;
  let completedRevision = 0;

  const getStableRevision = (): StableSampleRevision => (
    completedRevision === requestedRevision
      ? { state: 'stable', revision: requestedRevision }
      : { state: 'pending' }
  );

  const loop = createSingleFlightLoop<QueuedSample<TRequest>>({
    run: (queued) => deps.run(queued.request).then(() => {
      // Only a run that COMPLETED advances the ledger; a throwing ingest leaves
      // the revision pending, so nothing reads its watts as admitted.
      completedRevision = queued.revision;
    }),
    // Newest wins: an older reading has nothing to add once a newer one exists.
    nextRequest: (queued) => queued,
    mayContinue: () => true,
    onRequest: ({ join, replacedQueued }) => {
      if (join === 'started') return;
      incPerfCounter(replacedQueued
        ? 'power_sample_rerun_coalesced_total'
        : 'power_sample_rerun_requested_total');
    },
    onRerun: () => incPerfCounter('power_sample_rerun_executed_total'),
  });

  /**
   * A synchronously re-entrant caller — which the loop answers immediately with
   * `queued` rather than letting it start a second pass — reads its verdict
   * before its request has run, so it sees `superseded` with
   * `revision === latestRevision`: superseded by itself. Every consumer treats
   * anything but `admitted` as "do not claim meter authority", so the answer is
   * the conservative one either way.
   */
  const resolveAdmission = (revision: number): SampleAdmission => {
    const stable = getStableRevision();
    return stable.state === 'stable' && stable.revision === revision
      ? { state: 'admitted', revision }
      : { state: 'superseded', revision, latestRevision: requestedRevision };
  };

  return {
    submit: async (buildRequest) => {
      requestedRevision += 1;
      const revision = requestedRevision;
      incPerfCounter('power_sample_requested_total');
      await loop.request({ revision, request: buildRequest(revision) });
      return resolveAdmission(revision);
    },
    getStableRevision,
  };
};
