import { classifyPowerSourceChoice, type PowerSourceChoiceRead } from '../lib/power/powerSource';
import { readPowerSourceEvidence, type PowerSourceSettingsPort } from './powerSourceEvidence';
/**
 * The owner's source choice, which retains an unset key. Same evidence and
 * suspect arms as `readConfiguredPowerSource`, plus the `read_failed` only an
 * I/O boundary can produce.
 */
export const readPowerSourceChoice = (settings: PowerSourceSettingsPort): PowerSourceChoiceRead => {
  try {
    return classifyPowerSourceChoice(readPowerSourceEvidence(settings));
  } catch {
    return { state: 'suspect', reason: 'read_failed' };
  }
};
