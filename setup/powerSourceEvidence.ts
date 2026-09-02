import type { PowerSourceSettingEvidence } from '../lib/power/powerSource';
import { POWER_SOURCE } from '../lib/utils/settingsKeys';

export type PowerSourceSettingsPort = {
  get(key: string): unknown;
  getKeys(): string[];
};

/**
 * The raw `power_source` read plus the key-list evidence that classifies its
 * absence, gathered once for both readers of the key (`powerSourceSettings.ts`
 * and `powerSourceChoice.ts`). May throw: each reader owns its own failure arm.
 */
export const readPowerSourceEvidence = (settings: PowerSourceSettingsPort): PowerSourceSettingEvidence => {
  const raw = settings.get(POWER_SOURCE);
  if (raw !== undefined && raw !== null) return { raw, keyPresent: false, keyListEmpty: false };
  const keys = settings.getKeys();
  return { raw, keyPresent: keys.includes(POWER_SOURCE), keyListEmpty: keys.length === 0 };
};
