import { classifyPowerSourceChoice, type PowerSourceChoiceClassification } from '../lib/power/powerSource';
import { readPowerSourceEvidence, type PowerSourceSettingsPort } from './powerSourceEvidence';
/**
 * The owner's source CHOICE, for the one consumer that must not collapse an
 * unset key to Flow (the boot-time sole-meter adoption). Same evidence and
 * suspect arms as `readConfiguredPowerSource`, plus the `read_failed` only an
 * I/O boundary can produce.
 */
export type PowerSourceChoiceRead =
  | PowerSourceChoiceClassification
  | { state: 'suspect'; reason: 'read_failed' };

export const readPowerSourceChoice = (settings: PowerSourceSettingsPort): PowerSourceChoiceRead => {
  try {
    return classifyPowerSourceChoice(readPowerSourceEvidence(settings));
  } catch {
    return { state: 'suspect', reason: 'read_failed' };
  }
};
