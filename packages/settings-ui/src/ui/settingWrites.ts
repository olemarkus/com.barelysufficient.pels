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
