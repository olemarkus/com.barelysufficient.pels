import { getSettingFresh, setSetting } from '../homey.ts';
import { logSettingsError } from '../logging.ts';
import { showToastError } from '../toast.ts';

type FreshSettingWriteParams<T> = {
  key: string;
  context: string;
  logMessage: string;
  toastMessage: string;
  /**
   * The caller's best-known current snapshot of the persisted value
   * (e.g. `state.budgetExemptMap`). When the Homey SDK read transiently
   * resolves to null/undefined or returns a malformed value, the helper
   * falls back to this snapshot rather than to an empty object so the
   * subsequent merge preserves entries the UI already knows about.
   * Callers MUST pass their live local snapshot here — never a fresh `{}`
   * literal — otherwise a transient SDK blip can erase unrelated keys
   * (project memory feedback_homey_sdk_unreliable).
   */
  fallbackValue: T;
  /**
   * Normalises a non-null SDK value into the caller's expected shape.
   * Return null/undefined to signal "unrecoverable; use the snapshot
   * fallback instead". When the SDK resolves to null/undefined the helper
   * skips `readFresh` entirely and uses `fallbackValue`.
   */
  readFresh?: (value: unknown, fallbackValue: T) => T | null | undefined;
  mutate: (currentValue: T) => T;
  commit?: (nextValue: T) => Promise<void> | void;
  rollback?: () => Promise<void> | void;
};

export const readRecordSetting = <T>(
  value: unknown,
  fallbackValue: Record<string, T> = {},
): Record<string, T> => (
  value && typeof value === 'object' && !Array.isArray(value)
    ? { ...(value as Record<string, T>) }
    : { ...fallbackValue }
);

/**
 * Strict record reader for the `readFresh` slot of `writeFreshSetting`.
 * Returns the cloned record only when the SDK value is a real, non-array
 * object. Returns `null` otherwise so `writeFreshSetting` can fall back to
 * the caller-provided snapshot instead of normalising a malformed value
 * into an empty map.
 */
export const readRecordSettingStrict = <T>(value: unknown): Record<string, T> | null => (
  value && typeof value === 'object' && !Array.isArray(value)
    ? { ...(value as Record<string, T>) }
    : null
);

export const createSerializedAsyncRunner = () => {
  let pendingOperation: Promise<void> = Promise.resolve();

  return async <T>(operation: () => Promise<T>): Promise<T> => {
    const previousOperation = pendingOperation;
    let releaseCurrentOperation!: () => void;
    pendingOperation = new Promise<void>((resolve) => {
      releaseCurrentOperation = resolve;
    });

    await previousOperation;
    try {
      return await operation();
    } finally {
      releaseCurrentOperation();
    }
  };
};

export const writeFreshSetting = async <T>(params: FreshSettingWriteParams<T>): Promise<T | null> => {
  // Default normaliser: pass through real, non-array objects untouched and
  // signal "unrecoverable" otherwise. Callers can provide their own
  // readFresh to validate domain shape; the helper still routes a
  // null/undefined return through the snapshot fallback below.
  const readFresh = params.readFresh ?? ((value: unknown) => (
    value && typeof value === 'object' && !Array.isArray(value)
      ? value as T
      : null
  ));

  try {
    const freshValue = await getSettingFresh(params.key);
    // Project memory feedback_homey_sdk_unreliable: a transient SDK blip can
    // resolve to null/undefined even when persisted state exists. Fall back
    // to the caller's local snapshot rather than to an empty object so we
    // never write a partial map that erases unrelated keys. The same path
    // covers the legitimate first-write case where the key truly has no
    // value yet — `fallbackValue` is then the caller's empty snapshot,
    // which is correct.
    const normalised = (freshValue === null || freshValue === undefined)
      ? null
      : readFresh(freshValue, params.fallbackValue);
    const currentValue = (normalised === null || normalised === undefined)
      ? params.fallbackValue
      : normalised;
    const nextValue = params.mutate(currentValue);
    await setSetting(params.key, nextValue);
    await params.commit?.(nextValue);
    return nextValue;
  } catch (error) {
    await logSettingsError(params.logMessage, error, params.context);
    await showToastError(error, params.toastMessage);
    await params.rollback?.();
    return null;
  }
};
