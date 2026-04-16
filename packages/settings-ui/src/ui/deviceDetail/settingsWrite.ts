import { getSettingFresh, setSetting } from '../homey.ts';
import { logSettingsError } from '../logging.ts';
import { showToastError } from '../toast.ts';

type FreshSettingWriteParams<T> = {
  key: string;
  context: string;
  logMessage: string;
  toastMessage: string;
  fallbackValue: T;
  readFresh?: (value: unknown, fallbackValue: T) => T;
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

export const writeFreshSetting = async <T>(params: FreshSettingWriteParams<T>): Promise<T | null> => {
  const readFresh = params.readFresh ?? ((value: unknown) => (
    (value === undefined || value === null) ? params.fallbackValue : value as T
  ));

  try {
    const freshValue = await getSettingFresh(params.key);
    const currentValue = readFresh(freshValue, params.fallbackValue);
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
