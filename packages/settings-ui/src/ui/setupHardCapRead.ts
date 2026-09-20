import type { CapacityScalarSettings } from '../../../contracts/src/capacitySettings.ts';
import { CAPACITY_LIMIT_KW } from '../../../contracts/src/settingsKeys.ts';
import { publishSetupHardCapRead } from './setupPathFacts.ts';
import { confirmSettingAbsence } from './settingAbsence.ts';

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
 * So absence is confirmed before it is published (`confirmSettingAbsence`).
 * Until then the path stays `loading` and draws no step. Only a read that
 * stays nullish through every retry is a home that has not chosen a cap.
 */
const isSavedCap = (value: unknown): value is number => (
  typeof value === 'number' && Number.isFinite(value)
);

export const reportSetupHardCapRead = async (
  persistedLimitKw: unknown,
  running: CapacityScalarSettings,
): Promise<void> => {
  const confirmed = await confirmSettingAbsence(CAPACITY_LIMIT_KW, persistedLimitKw, isSavedCap);
  // Unreadable: publish nothing. The path stays `loading` and judges no step,
  // rather than telling a configured home it never chose a cap.
  if (confirmed.state === 'unavailable') return;
  publishSetupHardCapRead(confirmed.state === 'present' ? confirmed.value : undefined, running);
};
