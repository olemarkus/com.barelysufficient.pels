import type { CapacityScalarSettings } from '../../../contracts/src/capacitySettings.ts';
import { CAPACITY_LIMIT_KW } from '../../../contracts/src/settingsKeys.ts';
import { getSettingFresh, sleep } from './homey.ts';
import { publishSetupHardCapRead } from './setupPathFacts.ts';

/**
 * Tells the setup path whether the owner has saved a hard cap.
 *
 * A saved cap is a number, and one read settles it. "Never saved" is an absent
 * key, which Homey spells exactly as it spells a settings store it transiently
 * could not read: a nullish value. Believing the first nullish read sent the
 * owner of a fully configured home back to the Hard cap step for the rest of
 * the session, because nothing had been seen yet for the saved-cap latch to
 * hold on to.
 *
 * So absence is confirmed before it is published, by fresh re-reads past the
 * settings cache — the same treatment the recommendation acknowledgements get
 * (`recommendations.ts`). Until then the path stays `loading` and draws no
 * step. Only a read that stays nullish through every retry is a home that has
 * not chosen a cap.
 */
const CONFIRM_ABSENT_RETRY_DELAYS_MS = [250, 750] as const;

const isSavedCap = (value: unknown): value is number => (
  typeof value === 'number' && Number.isFinite(value)
);

const readFreshCap = async (): Promise<unknown> => {
  const [read] = await Promise.allSettled([getSettingFresh(CAPACITY_LIMIT_KW)]);
  // A thrown read is one more unreadable answer, not evidence of absence.
  return read.status === 'fulfilled' ? read.value : undefined;
};

export const reportSetupHardCapRead = async (
  persistedLimitKw: unknown,
  running: CapacityScalarSettings,
): Promise<void> => {
  let persisted = persistedLimitKw;
  for (const delayMs of CONFIRM_ABSENT_RETRY_DELAYS_MS) {
    if (isSavedCap(persisted)) break;
    await sleep(delayMs);
    persisted = await readFreshCap();
  }
  publishSetupHardCapRead(persisted, running);
};
