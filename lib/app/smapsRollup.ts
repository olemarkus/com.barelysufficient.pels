import fs from 'node:fs';

const SMAPS_ROLLUP_PATH = '/proc/self/smaps_rollup';

let smapsRollupSupported: boolean | undefined;
let cachedInitialRollup: string | null | undefined;

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
