/* eslint-disable functional/immutable-data -- Local parser accumulates per-mapping totals into a result object. */
import fs from 'node:fs';

const SMAPS_ROLLUP_PATH = '/proc/self/smaps_rollup';
const SMAPS_PATH = '/proc/self/smaps';
const TOP_ANON_COUNT = 5;
// Sample the detail parser every N calls; reuse the last result otherwise.
// At the default 30 s perf flush interval this yields one full /proc/self/smaps
// scan every ~3 minutes — enough for a mapping-leak signal without scanning the
// file on every flush.
const SMAPS_DETAIL_SAMPLE_EVERY = 6;

let smapsRollupSupported: boolean | undefined;
let cachedInitialRollup: string | null | undefined;
let smapsDetailSupported: boolean | undefined;
let smapsDetailCallIndex = 0;
let cachedSmapsDetail: SmapsDetail | null = null;

const isNonRetryableSmapsProbeError = (error: unknown): boolean => {
  const code = typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : '';
  return code === 'ENOENT' || code === 'ENOTDIR' || code === 'EACCES' || code === 'EPERM';
};

const readSmapsRollup = (): string | null => {
  if (smapsRollupSupported === false) return null;

  if (smapsRollupSupported === undefined) {
    try {
      const rollup = fs.readFileSync(SMAPS_ROLLUP_PATH, 'utf8');
      smapsRollupSupported = true;
      cachedInitialRollup = rollup;
    } catch (error) {
      if (isNonRetryableSmapsProbeError(error)) {
        smapsRollupSupported = false;
        cachedInitialRollup = null;
      }
      return null;
    }
  }

  if (typeof cachedInitialRollup === 'string') {
    const rollup = cachedInitialRollup;
    cachedInitialRollup = undefined;
    return rollup;
  }

  try {
    return fs.readFileSync(SMAPS_ROLLUP_PATH, 'utf8');
  } catch {
    return null;
  }
};

/** Reset module-level probe state. For tests only. */
export const _resetSmapsCacheForTests = (): void => {
  smapsRollupSupported = undefined;
  cachedInitialRollup = undefined;
};

export const resolveSmapsSummary = (): Record<string, number> | null => {
  const rollup = readSmapsRollup();
  if (!rollup) return null;

  const extract = (key: string): number => {
    const match = rollup.match(new RegExp(`${key}:\\s+(\\d+)`));
    return match ? Math.round(parseInt(match[1], 10) / 1024) : -1;
  };

  return {
    rssMb: extract('Rss'),
    pssMb: extract('Pss'),
    pssAnonMb: extract('Pss_Anon'),
    pssFileMb: extract('Pss_File'),
  };
};

type SmapsDetail = {
  anonRssMb: number;
  fileRssMb: number;
  heapRssMb: number;
  stackRssMb: number;
  anonMappings: number;
  topAnonRssMb: number[];
};

const classifyMappingPath = (pathname: string): 'anon' | 'heap' | 'stack' | 'file' => {
  if (pathname === '') return 'anon';
  if (pathname === '[heap]') return 'heap';
  if (pathname.startsWith('[stack')) return 'stack';
  // Linux kernels name anon VMAs via PR_SET_VMA_ANON_NAME, producing entries
  // like `[anon:<name>]` or `[anon_shmem:<name>]`. These must be bucketed as
  // anonymous, not file-backed.
  if (pathname.startsWith('[anon:') || pathname.startsWith('[anon_shmem:')) return 'anon';
  return 'file';
};

const readSmapsDetail = (): string | null => {
  if (smapsDetailSupported === false) return null;
  try {
    const data = fs.readFileSync(SMAPS_PATH, 'utf8');
    smapsDetailSupported = true;
    return data;
  } catch (error) {
    if (isNonRetryableSmapsProbeError(error)) {
      smapsDetailSupported = false;
    }
    return null;
  }
};

const parseSmapsDetail = (data: string): SmapsDetail | null => {
  try {
    const lines = data.split('\n');
    const totals = { anon: 0, file: 0, heap: 0, stack: 0 };
    const anonRss: number[] = [];
    let category: 'anon' | 'heap' | 'stack' | 'file' = 'anon';
    let currentRss = 0;
    let inMapping = false;
    const flush = (): void => {
      if (!inMapping) return;
      totals[category] += currentRss;
      if (category === 'anon') anonRss.push(currentRss);
    };
    for (const line of lines) {
      if (/^[0-9a-f]+-[0-9a-f]+\s/.test(line)) {
        flush();
        const parts = line.split(/\s+/);
        const pathname = parts.slice(5).join(' ').trim();
        category = classifyMappingPath(pathname);
        currentRss = 0;
        inMapping = true;
      } else if (line.startsWith('Rss:')) {
        const match = line.match(/Rss:\s+(\d+)/);
        if (match) currentRss = parseInt(match[1], 10);
      }
    }
    flush();
    anonRss.sort((a, b) => b - a);
    const toMb = (kb: number): number => Math.round(kb / 1024 * 10) / 10;
    return {
      anonRssMb: toMb(totals.anon),
      fileRssMb: toMb(totals.file),
      heapRssMb: toMb(totals.heap),
      stackRssMb: toMb(totals.stack),
      anonMappings: anonRss.length,
      topAnonRssMb: anonRss.slice(0, TOP_ANON_COUNT).map(toMb),
    };
  } catch {
    return null;
  }
};

/**
 * Returns smaps detail. Throttled: scans `/proc/self/smaps` once every
 * SMAPS_DETAIL_SAMPLE_EVERY calls and returns the cached result in between.
 * Returns null when the platform doesn't expose smaps (probe cached).
 */
export const resolveSmapsDetail = (): SmapsDetail | null => {
  if (smapsDetailSupported === false) return null;
  const shouldSample = smapsDetailCallIndex % SMAPS_DETAIL_SAMPLE_EVERY === 0;
  smapsDetailCallIndex += 1;
  if (!shouldSample) return cachedSmapsDetail;
  const data = readSmapsDetail();
  if (!data) return cachedSmapsDetail;
  const parsed = parseSmapsDetail(data);
  if (parsed) cachedSmapsDetail = parsed;
  return cachedSmapsDetail;
};

/**
 * Test-only hook. Resets the cached smaps probe + throttle counter so a test
 * can exercise both first-call sampling and the cached path.
 */
export const __resetSmapsDetailCacheForTests = (): void => {
  smapsDetailSupported = undefined;
  smapsDetailCallIndex = 0;
  cachedSmapsDetail = null;
};
