import type { ContestedSetting, ContestedValue } from '../../contracts/src/controlContest';

/** What the owner calls each setting PELS can keep setting back, in the warning and in the event report. */
export const CONTESTED_SETTING_WORDS: Readonly<Record<ContestedSetting, string>> = {
  temperature: 'temperature',
  on_off: 'on/off setting',
  level: 'level',
};

/** A journalled event's `setting`, which comes back from storage untyped. */
export const isContestedSetting = (value: unknown): value is ContestedSetting => (
  typeof value === 'string' && Object.hasOwn(CONTESTED_SETTING_WORDS, value)
);

/** A contested value as the warning and the event report write it: `5 °C`, `on`, or a step id. */
export const formatContestedValue = (setting: ContestedSetting, value: ContestedValue): string => {
  if (setting === 'on_off') return value === true ? 'on' : 'off';
  if (setting === 'temperature' && typeof value === 'number') return `${value} °C`;
  return String(value);
};
