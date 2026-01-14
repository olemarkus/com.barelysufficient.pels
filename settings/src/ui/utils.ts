import { setSetting } from './homey';

/**
 * Escape HTML special characters to prevent XSS attacks.
 */
export const escapeHtml = (str: string): string => {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
};

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

/**
 * Debounced save queue - coalesces rapid saves to the same setting key.
 * Uses 300ms delay to allow multiple rapid changes before saving.
 */
const pendingSaves = new Map<string, PendingSave>();
const DEBOUNCE_DELAY_MS = 300;

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

export const debouncedSetSetting = <T>(key: string, getValue: () => T): Promise<void> => {
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
