import { setSetting } from './homey';

/**
 * Get a human-readable "time ago" string.
 */
export const getTimeAgo = (date: Date, now: Date, timeZone: string): string => {
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / (1000 * 60));
  const diffHours = Math.floor(diffMs / (1000 * 60 * 60));

  if (diffMins < 1) return 'just now';
  if (diffMins === 1) return '1 minute ago';
  if (diffMins < 60) return `${diffMins} minutes ago`;
  if (diffHours === 1) return '1 hour ago';
  if (diffHours < 24) return `${diffHours} hours ago`;
  return date.toLocaleString([], { timeZone });
};

type PendingSave = {
  timeout: ReturnType<typeof setTimeout>;
  promise: Promise<void>;
  resolve: () => void;
  reject: (error: unknown) => void;
  getValue: () => unknown;
};

type DebouncedSettingSaver = {
  debouncedSetSetting: <T>(key: string, getValue: () => T) => Promise<void>;
  flushPendingSaves: () => Promise<void>;
};

/**
 * Debounced save queue - coalesces rapid saves to the same setting key.
 * Uses 300ms delay to allow multiple rapid changes before saving.
 */
const createDebouncedSettingSaver = (): DebouncedSettingSaver => {
  const pendingSaves = new Map<string, PendingSave>();
  const DEBOUNCE_DELAY_MS = 300;
  let flushPromise: Promise<void> | null = null;

  const resetPendingEntry = (entry: PendingSave): PendingSave => {
    let resolve: () => void;
    let reject: (error: unknown) => void;
    const promise = new Promise<void>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return {
      ...entry,
      promise,
      resolve: resolve!,
      reject: reject!,
      timeout: setTimeout(() => {}, 0),
    };
  };

  const schedulePendingSave = (key: string, entry: PendingSave): PendingSave => {
    clearTimeout(entry.timeout);
    const timeout = setTimeout(async () => {
      pendingSaves.delete(key);
      try {
        await setSetting(key, entry.getValue());
        entry.resolve();
      } catch (error) {
        entry.reject(error);
      }
    }, DEBOUNCE_DELAY_MS);
    const nextEntry = { ...entry, timeout };
    pendingSaves.set(key, nextEntry);
    return nextEntry;
  };

  const debouncedSetSetting = <T>(key: string, getValue: () => T): Promise<void> => {
    const existing = pendingSaves.get(key);
    if (existing) {
      const nextEntry = { ...existing, getValue: getValue as () => unknown };
      schedulePendingSave(key, nextEntry);
      return nextEntry.promise;
    }

    let resolve: () => void;
    let reject: (error: unknown) => void;
    const promise = new Promise<void>((res, rej) => {
      resolve = res;
      reject = rej;
    });

    const entry: PendingSave = {
      timeout: setTimeout(() => {}, 0),
      promise,
      resolve: resolve!,
      reject: reject!,
      getValue: getValue as () => unknown,
    };

    schedulePendingSave(key, entry);
    return promise;
  };

  const flushPendingSaves = (): Promise<void> => {
    if (flushPromise) return flushPromise;
    flushPromise = (async () => {
      if (pendingSaves.size === 0) return;
      const keysToFlush = Array.from(pendingSaves.keys());
      const errors: unknown[] = [];
      await Promise.all(keysToFlush.map(async (key) => {
        const entry = pendingSaves.get(key);
        if (!entry) return;
        clearTimeout(entry.timeout);
        try {
          await setSetting(key, entry.getValue());
          entry.resolve();
          const current = pendingSaves.get(key);
          if (current === entry) {
            pendingSaves.delete(key);
          }
        } catch (error) {
          entry.reject(error);
          errors.push(error);
          const current = pendingSaves.get(key);
          if (current && current.promise === entry.promise) {
            clearTimeout(current.timeout);
            pendingSaves.set(key, resetPendingEntry(current));
          }
        }
      }));
      if (errors.length) {
        const flushError = new Error('Failed to flush pending setting saves');
        (flushError as Error & { causes?: unknown[] }).causes = errors;
        throw flushError;
      }
    })();
    return flushPromise.finally(() => {
      flushPromise = null;
    });
  };

  return { debouncedSetSetting, flushPendingSaves };
};

const { debouncedSetSetting, flushPendingSaves } = createDebouncedSettingSaver();

let flushListenerCleanup: (() => void) | undefined;

export const initDebouncedSaveFlush = (): (() => void) | undefined => {
  if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') return undefined;
  if (flushListenerCleanup) {
    flushListenerCleanup();
    flushListenerCleanup = undefined;
  }
  const handler = () => {
    // Best-effort flush on unload; browsers may not wait for async work to finish.
    void flushPendingSaves().catch(() => {
      // Avoid leaking details to console on unload; keep message generic.
      console.error('Failed to flush pending setting saves before unload.');
    });
  };
  window.addEventListener('beforeunload', handler);
  window.addEventListener('pagehide', handler);
  const cleanup = () => {
    window.removeEventListener('beforeunload', handler);
    window.removeEventListener('pagehide', handler);
    flushListenerCleanup = undefined;
  };
  flushListenerCleanup = cleanup;
  return cleanup;
};

export { debouncedSetSetting };
export const flushDebouncedSettingSaves = flushPendingSaves;
