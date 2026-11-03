import type { ContestedSetting } from '../../contracts/src/controlContest';

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
