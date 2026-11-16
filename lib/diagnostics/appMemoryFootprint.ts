import v8 from 'node:v8';
import { isUnknownRecord } from '../../packages/shared-domain/src/recordGuards';
import { getLogger } from '../logging/logger';
import { type HomeyAppManagerRuntime, requestHomeyAppManager } from './homeyAppManagerRequest';

const logger = getLogger('perf/app-memory');

const MB = 1024 * 1024;
const roundMb = (bytes: number): number => Math.round(bytes / MB * 10) / 10;

/**
 * The app's own process counters, from getrusage(2).
 *
 * Homey's app sandbox mounts no `/proc`, so `process.memoryUsage()` and
 * `/proc/self/smaps` both fail there; getrusage is a system call and still
 * answers. Major faults are pages read back in from swap or storage, which is
 * how hard the kernel has been paging this process. `maxRssMb` is a high-water
 * mark: it only rises, so it cannot show a drop after a step.
 */
export type ProcessFaults = {
  maxRssMb: number;
  minorFaults: number;
  majorFaults: number;
};

export const resolveProcessFaults = (): ProcessFaults => {
  const usage = process.resourceUsage();
  return {
    // getrusage reports maxRSS in kilobytes on Linux.
    maxRssMb: Math.round(usage.maxRSS / 1024 * 10) / 10,
    minorFaults: usage.minorPageFault,
    majorFaults: usage.majorPageFault,
  };
};

/**
 * What Homey itself measures for this app, from its own `/usage` route.
 *
 * Homey compares the app's RSS with its memory warning line, and that RSS
 * includes the Node runtime's shared pages (about 55 MB on a Homey Pro), so
 * `rssMb - sharedCleanMb` is the part PELS can change. `swapMb` is the app's
 * proportional share of swapped-out pages, which RSS leaves out.
 */
export type AppMemoryUsage = {
  atMs: number;
  rssMb: number;
  pssMb: number;
  sharedCleanMb: number;
  swapMb: number;
};


const REQUEST_TIMEOUT_MS = 10_000;

const readFiniteBytes = (record: Record<string, unknown>, key: string): number | null => {
  const value = record[key];
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
};

/** Accepts Homey's `/usage` answer only when every field this app reports is a finite byte count. */
export const parseAppMemoryUsage = (body: unknown, atMs: number): AppMemoryUsage | null => {
  if (!isUnknownRecord(body) || !isUnknownRecord(body.mem)) return null;
  const rss = readFiniteBytes(body.mem, 'rss');
  const pss = readFiniteBytes(body.mem, 'pss');
  const sharedClean = readFiniteBytes(body.mem, 'sharedClean');
  const pssSwap = readFiniteBytes(body.mem, 'pssSwap');
  if (rss === null || pss === null || sharedClean === null || pssSwap === null) return null;
  return {
    atMs,
    rssMb: roundMb(rss),
    pssMb: roundMb(pss),
    sharedCleanMb: roundMb(sharedClean),
    swapMb: roundMb(pssSwap),
  };
};

/**
 * Reads this app's memory as Homey measures it, and keeps the last accepted
 * reading. A failed or malformed read leaves the previous reading in place;
 * `latest()` is null only until the first reading is accepted.
 */
export class AppMemoryUsageSampler {
  private last: AppMemoryUsage | null = null;
  private inFlight: Promise<AppMemoryUsage | null> | null = null;
  private failureLogged = false;

  constructor(private readonly homey: HomeyAppManagerRuntime) {}

  latest(): AppMemoryUsage | null {
    return this.last;
  }

  /** One request at a time; a caller during a read shares its result. */
  refresh(): Promise<AppMemoryUsage | null> {
    if (!this.inFlight) {
      this.inFlight = this.read().finally(() => {
        this.inFlight = null;
      });
    }
    return this.inFlight;
  }

  private async read(): Promise<AppMemoryUsage | null> {
    try {
      const body = await this.request();
      const usage = parseAppMemoryUsage(body, Date.now());
      if (!usage) {
        this.logFailureOnce('malformed');
        return null;
      }
      this.last = usage;
      return usage;
    } catch (error) {
      this.logFailureOnce(error instanceof Error ? error.message : String(error));
      return null;
    }
  }

  private logFailureOnce(reason: string): void {
    if (this.failureLogged) return;
    this.failureLogged = true;
    logger.warn({ event: 'app_memory_usage_unavailable', reason });
  }

  private async request(): Promise<unknown> {
    const response = await requestHomeyAppManager(this.homey, '/usage', 'GET', undefined, REQUEST_TIMEOUT_MS);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.body;
  }
}

/** Homey's reading as of `nowMs`, with how old it is, and the process counters. */
export const describeAppMemoryFootprint = (
  sampler: AppMemoryUsageSampler,
  nowMs: number,
): { usage: (AppMemoryUsage & { ageSec: number }) | null; faults: ProcessFaults } => {
  const usage = sampler.latest();
  return {
    usage: usage ? { ...usage, ageSec: Math.round((nowMs - usage.atMs) / 1000) } : null,
    faults: resolveProcessFaults(),
  };
};

/**
 * What V8 holds, next to Homey's reading: the JS heap, and the compiled code
 * inside it that grows as V8 optimises PELS's hot functions. Reading the code
 * statistics walks the code spaces (a few ms), so it belongs to a snapshot,
 * not to every warning.
 */
export type AppHeapReading = {
  heapUsedMb: number;
  heapTotalMb: number;
  externalMb: number;
  mallocMb: number;
  codeMb: number;
  bytecodeMb: number;
};

export const resolveAppHeapReading = (): AppHeapReading => {
  const heap = v8.getHeapStatistics();
  const code = v8.getHeapCodeStatistics();
  return {
    heapUsedMb: roundMb(heap.used_heap_size),
    heapTotalMb: roundMb(heap.total_heap_size),
    externalMb: roundMb(heap.external_memory),
    mallocMb: roundMb(heap.malloced_memory),
    codeMb: roundMb(code.code_and_metadata_size),
    bytecodeMb: roundMb(code.bytecode_and_metadata_size),
  };
};

/** Everything known about the app's memory at one moment, for the log and the support report. */
export type AppMemorySnapshot = ReturnType<typeof describeAppMemoryFootprint> & { heap: AppHeapReading };

/** Asks Homey for a fresh reading first; a failed read leaves the last accepted one, with its age. */
export const captureAppMemorySnapshot = async (sampler: AppMemoryUsageSampler): Promise<AppMemorySnapshot> => {
  await sampler.refresh();
  return { ...describeAppMemoryFootprint(sampler, Date.now()), heap: resolveAppHeapReading() };
};

