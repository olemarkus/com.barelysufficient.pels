import type { ContestedControl } from '../../../contracts/src/controlContest.ts';

/** What the owner calls the setting PELS kept losing. */
const settingWord = (capabilityId: string): string => {
  if (capabilityId === 'target_temperature') return 'temperature';
  if (capabilityId === 'onoff' || capabilityId.startsWith('onoff.')) return 'on/off setting';
  return 'setting';
};

/**
 * The warning for a device that keeps moving away from what PELS set: a write
 * that does not stick points at the device's own app, another value at
 * whatever else sets the device. The house-level effect is the same, so both
 * say why it matters.
 */
export const controlContestNotice = (
  name: string,
  contest: ContestedControl,
): { title: string; body: string } => {
  const what = settingWord(contest.capabilityId);
  const effect = 'While that goes on, other devices wait to resume.';
  if (contest.kind === 'reverted') {
    return {
      title: `${name} doesn't keep PELS's changes`,
      body: `${contest.count} times in the last hour, ${name} went back to its earlier ${what} `
        + `a few minutes after PELS changed it. ${effect} Check the app that controls ${name}, `
        + 'or turn off Managed by PELS for it.',
    };
  }
  return {
    title: `Something keeps changing ${name}`,
    body: `${contest.count} times in the last hour, something outside PELS changed the ${what} of ${name} `
      + `right after PELS set it. ${effect} Look for a Flow, another app or a schedule that sets it, `
      + 'and turn that off, or turn off Managed by PELS for it.',
  };
};
