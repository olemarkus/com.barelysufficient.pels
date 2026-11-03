import type { ContestedControl } from '../../../contracts/src/controlContest.ts';
import { CONTESTED_SETTING_WORDS } from '../../../shared-domain/src/contestedSetting.ts';

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
  if (contest.kind === 'reverted') {
    return {
      title: `${name} doesn't keep PELS's changes`,
      body: `${contest.count} times in the last 2 hours, ${name} went back to its earlier ${what} `
        + `after PELS changed it. Check the app that controls ${name}, `
        + 'or turn off Managed by PELS for it.',
    };
  }
  return {
    title: `Something keeps changing ${name}`,
    body: `${contest.count} times in the last 2 hours, something outside PELS changed the ${what} of ${name} `
      + 'after PELS set it. Look for a Flow, another app or a schedule that sets it, '
      + 'and turn that off, or turn off Managed by PELS for it.',
  };
};
