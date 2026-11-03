import type { ContestedControl } from '../../../contracts/src/controlContest.ts';
import { CONTESTED_SETTING_WORDS } from '../../../shared-domain/src/contestedSetting.ts';

/**
 * The lighter choice for a temperature, in the same Setup section as Managed
 * by PELS: PELS stops setting the temperature and keeps the device managed.
 */
const KEEP_NEW_TEMPERATURE = 'choose “Keep the new temperature” under “When the temperature changes outside PELS”';

/**
 * The warning for a device that keeps moving away from what PELS set: a write
 * that does not stick points at the device's own app, another value at
 * whatever else sets the device.
 */
export const controlContestNotice = (
  name: string,
  contest: ContestedControl,
): { title: string; body: string } => {
  const what = CONTESTED_SETTING_WORDS[contest.setting];
  // A contest lasts until its latest round is 2 hours old, so it may be down to one.
  const times = `${contest.count === 1 ? 'Once' : `${contest.count} times`} in the last 2 hours`;
  const temperature = contest.setting === 'temperature';
  if (contest.kind === 'reverted') {
    const remedy = temperature
      ? `Check the app that controls it, ${KEEP_NEW_TEMPERATURE}, or turn off Managed by PELS for it.`
      : `Check the app that controls ${name}, or turn off Managed by PELS for it.`;
    return {
      title: `${name} doesn't keep PELS's changes`,
      body: `${times}, ${name} went back to its earlier ${what} after PELS changed it. ${remedy}`,
    };
  }
  const remedy = temperature
    ? `Turn off the Flow, app or schedule that sets it. Or ${KEEP_NEW_TEMPERATURE}, `
      + 'or turn off Managed by PELS for it.'
    : 'Look for a Flow, another app or a schedule that sets it, and turn that off, '
      + 'or turn off Managed by PELS for it.';
  return {
    title: `Something keeps changing ${name}`,
    body: `${times}, something outside PELS changed the ${what} of ${name} after PELS set it. ${remedy}`,
  };
};
