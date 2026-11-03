import type { ContestedControl } from '../../../contracts/src/controlContest.ts';
import { formatContestedValue } from '../../../shared-domain/src/contestedSetting.ts';

/**
 * The warning for a device that keeps reporting another value after PELS sets
 * it. It says what PELS measured; Homey does not say who changed the value, so
 * the body names what can, starting with the device itself.
 */
export const controlContestNotice = (
  name: string,
  contest: ContestedControl,
): { title: string; body: string } => {
  const { count, setting } = contest;
  const commanded = formatContestedValue(setting, contest.commanded);
  const observed = formatContestedValue(setting, contest.observed);
  const title = `${name} doesn't keep PELS's changes`;
  if (setting === 'temperature') {
    return {
      title,
      body: `${count} times in the last hour, PELS set ${name} to ${commanded} and ${name} then reported ${observed}. `
        + `The device may not accept ${commanded}, or a Flow, another app or a schedule may set it. `
        + `Change the temperature PELS uses for ${name}, turn off what sets it, or turn off Managed by PELS for it.`,
    };
  }
  if (setting === 'on_off') {
    return {
      title,
      body: `${count} times in the last hour, PELS turned ${name} ${commanded} and ${name} then reported ${observed}. `
        + `Check for a Flow, another app, a schedule or the device's own app that turns it ${observed}, `
        + 'or turn off Managed by PELS for it.',
    };
  }
  return {
    title,
    body: `${count} times in the last hour, PELS set the level of ${name} and ${name} then reported another level. `
      + 'Check for a Flow, another app or the device\'s own app that sets it, or turn off Managed by PELS for it.',
  };
};
