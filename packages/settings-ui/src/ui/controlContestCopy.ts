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
  const { setting } = contest;
  // A contest lasts until its latest round is an hour old, so it may be down to one.
  const times = `${contest.count === 1 ? 'Once' : `${contest.count} times`} in the last hour`;
  const commanded = formatContestedValue(setting, contest.commanded);
  const observed = formatContestedValue(setting, contest.observed);
  const title = `${name} doesn't keep PELS's changes`;
  if (setting === 'charging_phases') {
    return {
      title,
      body: `${times}, PELS changed the charging phases of ${name} and the charger then reported another setting. `
        + 'Check the charger’s own phase control and any Flows that set it, '
        + 'or choose Leave to charger under Charging phases.',
    };
  }
  if (setting === 'temperature') {
    return {
      title,
      body: `${times}, PELS set ${name} to ${commanded} and ${name} then reported ${observed}. `
        + `The device may not accept ${commanded}, or a Flow, another app or a schedule may set it. `
        + `Change the temperature PELS uses for ${name}, turn off what sets it, or turn off Managed by PELS for it.`,
    };
  }
  if (setting === 'on_off') {
    return {
      title,
      body: `${times}, PELS turned ${name} ${commanded} and ${name} then reported ${observed}. `
        + `Check for a Flow, another app, a schedule or the device's own app that turns it ${observed}, `
        + 'or turn off Managed by PELS for it.',
    };
  }
  return {
    title,
    body: `${times}, PELS set the level of ${name} and ${name} then reported another level. `
      + 'Check for a Flow, another app or the device\'s own app that sets it, or turn off Managed by PELS for it.',
  };
};
