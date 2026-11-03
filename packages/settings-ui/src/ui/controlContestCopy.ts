import type { ContestedControl, ContestedSetting } from '../../../contracts/src/controlContest.ts';

/** What the owner calls the setting PELS kept setting back. */
const SETTING_WORDS: Readonly<Record<ContestedSetting, string>> = {
  temperature: 'temperature',
  on_off: 'on/off setting',
  level: 'level',
};

/**
 * The warning for a device that keeps moving away from what PELS set: a write
 * that does not stick points at the device's own app, another value at
 * whatever else sets the device.
 */
export const controlContestNotice = (
  name: string,
  contest: ContestedControl,
): { title: string; body: string } => {
  const what = SETTING_WORDS[contest.setting];
  if (contest.kind === 'reverted') {
    return {
      title: `${name} doesn't keep PELS's changes`,
      body: `${contest.count} times in the last hour, ${name} went back to its earlier ${what} `
        + `after PELS changed it. Check the app that controls ${name}, `
        + 'or turn off Managed by PELS for it.',
    };
  }
  return {
    title: `Something keeps changing ${name}`,
    body: `${contest.count} times in the last hour, something outside PELS changed the ${what} of ${name} `
      + 'after PELS set it. Look for a Flow, another app or a schedule that sets it, '
      + 'and turn that off, or turn off Managed by PELS for it.',
  };
};
