/**
 * Returns the heap pages V8 has already emptied but keeps committed.
 *
 * Ownership: the app's one V8-level memory lever. Homey Pro's watchdog counts
 * full RSS against a per-app ceiling, and PELS sits close to it. What eats the
 * margin is not live data: V8 frees the garbage from every large serialisation
 * but keeps the emptied pages pooled until its memory reducer runs, and the
 * reducer waits for an allocation lull a controller polling every 10 s never
 * has. Measured 2026-09-07 with the production settings blob: that churn left
 * 18–45 MB of such pages behind with a flat live heap, an ordinary full
 * collection returned none of it, and a `last-resort` collection — the same
 * kind the reducer itself schedules — returned it in about 10 ms.
 *
 * The collector is obtained at runtime because Homey starts the app without
 * `--expose-gc`. Setting the flag after startup is the established way to reach
 * it (the flag only exposes a builtin; it changes no heap policy), and a fresh
 * `vm` context is the only place the builtin is visible once exposed. Both are
 * resolved once and cached; a runtime that refuses either answers `unavailable`
 * rather than throwing into the warning path that called it.
 */
import v8 from 'node:v8';
import vm from 'node:vm';

/**
 * The one collection this module asks for. V8's `gc()` extension takes the
 * request as an options object; `last-resort` is the flavour that also
 * uncommits, which a plain major collection does not.
 */
type LastResortCollection = { type: 'major'; execution: 'sync'; flavor: 'last-resort' };
const LAST_RESORT_COLLECTION: LastResortCollection = { type: 'major', execution: 'sync', flavor: 'last-resort' };

type ExposedGc = (request: LastResortCollection) => void;

/** What the process occupied around a collection. `rssMb` is `null` where the
 *  platform refuses the read — Homey's sandbox makes `process.memoryUsage()`
 *  throw — and the heap figure then carries the comparison alone. */
type HeapFootprint = { heapTotalMb: number; rssMb: number | null };

type HeapReclaimOutcome =
  | { status: 'reclaimed'; durationMs: number; before: HeapFootprint; after: HeapFootprint }
  | { status: 'unavailable'; reason: string };

const MB = 1024 * 1024;
const roundMb = (bytes: number): number => Math.round(bytes / MB * 10) / 10;

// `undefined` = not yet resolved; `null` = resolved and absent on this runtime.
let exposedGc: ExposedGc | null | undefined;

const resolveExposedGc = (): ExposedGc | null => {
  if (exposedGc !== undefined) return exposedGc;
  try {
    const alreadyExposed = (globalThis as { gc?: unknown }).gc;
    if (typeof alreadyExposed === 'function') {
      exposedGc = alreadyExposed as ExposedGc;
      return exposedGc;
    }
    v8.setFlagsFromString('--expose-gc');
    const fromContext: unknown = vm.runInNewContext('gc');
    exposedGc = typeof fromContext === 'function' ? fromContext as ExposedGc : null;
  } catch {
    exposedGc = null;
  }
  return exposedGc;
};

const readFootprint = (): HeapFootprint => {
  const heapTotalMb = roundMb(v8.getHeapStatistics().total_heap_size);
  try {
    return { heapTotalMb, rssMb: roundMb(process.memoryUsage().rss) };
  } catch {
    return { heapTotalMb, rssMb: null };
  }
};

/**
 * Run one `last-resort` collection and report what it gave back.
 *
 * Synchronous and stop-the-world, ~10 ms on a 40 MB heap, so callers ration
 * it: once per memory warning at most every `HEAP_RECLAIM_MIN_INTERVAL_MS`
 * (`resourceWarnings.ts`), plus a slow backstop interval. It is never called
 * from a planning path.
 */
export const reclaimHeapPages = (): HeapReclaimOutcome => {
  const gc = resolveExposedGc();
  if (gc === null) return { status: 'unavailable', reason: 'gc_not_exposed' };
  const before = readFootprint();
  const startedAtMs = Date.now();
  try {
    gc(LAST_RESORT_COLLECTION);
  } catch (error) {
    return { status: 'unavailable', reason: error instanceof Error ? error.message : 'gc_failed' };
  }
  return {
    status: 'reclaimed',
    durationMs: Date.now() - startedAtMs,
    before,
    after: readFootprint(),
  };
};
