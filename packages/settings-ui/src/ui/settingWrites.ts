import { setSetting } from './homey.ts';

export const pushSettingWriteIfChanged = (
  writes: Array<Promise<void>>,
  key: string,
  currentValue: unknown,
  nextValue: unknown,
): void => {
  if (currentValue !== nextValue) {
    writes.push(setSetting(key, nextValue));
  }
};

// Every started write settles before the first failure is reported, so the
// caller's reconcile reads a store that no write of this save is still changing.
export const settleSettingWrites = async (writes: Array<Promise<void>>): Promise<void> => {
  const results = await Promise.allSettled(writes);
  const failed = results.find((result) => result.status === 'rejected');
  if (failed?.status === 'rejected') throw failed.reason;
};
