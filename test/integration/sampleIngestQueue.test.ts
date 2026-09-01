import { describe, expect, it } from 'vitest';
import { createSampleIngestQueue } from '../../lib/power/sampleIngestQueue';

type Sample = { revision: number };

/** A run whose completion the test controls, so overlap is deterministic. */
const buildQueue = (options: { onRun?: (sample: Sample) => void } = {}): {
  submit: (label?: string) => Promise<ReturnType<typeof describeAdmission>>;
  queue: ReturnType<typeof createSampleIngestQueue<Sample>>;
  ran: number[];
  release: () => void;
  nextRun: () => Promise<void>;
} => {
  const ran: number[] = [];
  const parked: Array<() => void> = [];
  const runEntered: Array<() => void> = [];
  const queue = createSampleIngestQueue<Sample>({
    run: async (sample) => {
      ran.push(sample.revision);
      options.onRun?.(sample);
      runEntered.splice(0).forEach((notify) => notify());
      await new Promise<void>((resolve) => { parked.push(() => resolve()); });
    },
  });
  return {
    queue,
    ran,
    submit: async () => describeAdmission(await queue.submit((revision) => ({ revision }))),
    release: () => { parked.shift()?.(); },
    nextRun: () => new Promise<void>((resolve) => { runEntered.push(() => resolve()); }),
  };
};

const describeAdmission = (
  admission: { state: string; revision: number; latestRevision?: number },
): string => (
  admission.state === 'admitted'
    ? `admitted:${admission.revision}`
    : `superseded:${admission.revision}/${admission.latestRevision}`
);

describe('createSampleIngestQueue', () => {
  it('admits a sample that finished with nothing newer behind it', async () => {
    const harness = buildQueue();
    const first = harness.submit();
    harness.release();
    await expect(first).resolves.toBe('admitted:1');
    expect(harness.queue.getStableRevision()).toEqual({ state: 'stable', revision: 1 });
  });

  it('reports pending while an ingest is in flight', async () => {
    const harness = buildQueue();
    const first = harness.submit();
    expect(harness.queue.getStableRevision()).toEqual({ state: 'pending' });
    harness.release();
    await first;
    expect(harness.queue.getStableRevision()).toEqual({ state: 'stable', revision: 1 });
  });

  it('coalesces to the newest request and supersedes the ones it displaced', async () => {
    const harness = buildQueue();
    const first = harness.submit();
    const second = harness.submit();
    const third = harness.submit();
    const rerun = harness.nextRun();
    harness.release();
    await rerun;
    // Revision 2 never ran: an older reading has nothing to add once a newer
    // one exists.
    expect(harness.ran).toEqual([1, 3]);
    harness.release();
    await expect(first).resolves.toBe('superseded:1/3');
    await expect(second).resolves.toBe('superseded:2/3');
    await expect(third).resolves.toBe('admitted:3');
  });

  it('takes revisions at the request edge, in call order', async () => {
    const seen: number[] = [];
    const harness = buildQueue({ onRun: (sample) => seen.push(sample.revision) });
    const first = harness.submit();
    const second = harness.submit();
    const rerun = harness.nextRun();
    harness.release();
    await rerun;
    harness.release();
    await Promise.all([first, second]);
    expect(seen).toEqual([1, 2]);
  });

  it('leaves the ledger pending when a run throws, so nothing reads its watts as admitted', async () => {
    const queue = createSampleIngestQueue<Sample>({
      run: async () => {
        await Promise.resolve();
        throw new Error('ingest failed');
      },
    });
    await expect(queue.submit((revision) => ({ revision }))).rejects.toThrow('ingest failed');
    // The revision was requested but never completed.
    expect(queue.getStableRevision()).toEqual({ state: 'pending' });
  });
});
