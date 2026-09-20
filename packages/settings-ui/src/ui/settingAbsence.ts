import { getSettingFresh, sleep } from './homey.ts';

/**
 * Tells "this setting was never saved" from "this read failed".
 *
 * Homey spells both the same way: a nullish value. The difference matters
 * wherever absence means something — a hard cap nobody chose, a feature nobody
 * turned on — because believing one bad read tells an owner to go and configure
 * what they configured long ago.
 *
 * So absence is confirmed before it is believed, by fresh re-reads past the
 * settings cache. A read that stays absent through every retry is absent; a
 * thrown re-read is one more unreadable answer, never evidence of absence.
 */

const CONFIRM_ABSENT_RETRY_DELAYS_MS = [250, 750] as const;

/**
 * `absent` is a verdict, and only a read that SUCCEEDED can give it. A re-read
 * that threw proves nothing about the key, so a sequence that ends on one is
 * `unavailable`: the caller claims nothing, exactly as if it had never asked.
 */
export type ConfirmedSetting<T> =
  | { state: 'present'; value: T }
  | { state: 'absent' }
  | { state: 'unavailable' };

export const confirmSettingAbsence = async <T>(
  key: string,
  firstRead: unknown,
  isPresent: (value: unknown) => value is T,
): Promise<ConfirmedSetting<T>> => {
  if (isPresent(firstRead)) return { state: 'present', value: firstRead };
  let lastReadSucceeded = true;
  for (const delayMs of CONFIRM_ABSENT_RETRY_DELAYS_MS) {
    await sleep(delayMs);
    const [read] = await Promise.allSettled([getSettingFresh(key)]);
    lastReadSucceeded = read.status === 'fulfilled';
    if (read.status === 'fulfilled' && isPresent(read.value)) return { state: 'present', value: read.value };
  }
  return lastReadSucceeded ? { state: 'absent' } : { state: 'unavailable' };
};
