import {
  classifyPowerSourceSetting,
  type PowerSource,
  type PowerSourceSettingClassification,
  type PowerSourceSettingSuspectReason,
} from '../lib/power/powerSource';
import { POWER_SOURCE } from '../lib/utils/settingsKeys';

type PowerSourceSettingsPort = {
  get(key: string): unknown;
  getKeys(): string[];
};

export type ConfiguredPowerSourceRead =
  | { state: 'resolved'; value: PowerSource }
  | {
    state: 'suspect';
    reason: PowerSourceSettingSuspectReason | 'read_failed';
    error: Error;
  };

const attachSuspectError = (
  classified: PowerSourceSettingClassification,
): ConfiguredPowerSourceRead => {
  if (classified.state === 'resolved') return classified;
  return {
    ...classified,
    error: new Error(`power source settings read is suspect: ${classified.reason}`),
  };
};

/** Classify the untrusted persisted source without converting transient absence to Flow. */
export const readConfiguredPowerSource = (
  settings: PowerSourceSettingsPort,
): ConfiguredPowerSourceRead => {
  try {
    const raw = settings.get(POWER_SOURCE);
    if (raw !== undefined && raw !== null) {
      return attachSuspectError(classifyPowerSourceSetting({
        raw,
        keyPresent: false,
        keyListEmpty: false,
      }));
    }
    const keys = settings.getKeys();
    return attachSuspectError(classifyPowerSourceSetting({
      raw,
      keyPresent: keys.includes(POWER_SOURCE),
      keyListEmpty: keys.length === 0,
    }));
  } catch (error) {
    return {
      state: 'suspect',
      reason: 'read_failed',
      error: new Error('failed to read the configured power source', { cause: error }),
    };
  }
};

/** Throwing adapter for consumers whose existing retry/error path is exception-based. */
export const requireConfiguredPowerSource = (
  settings: PowerSourceSettingsPort,
): PowerSource => {
  const read = readConfiguredPowerSource(settings);
  if (read.state === 'resolved') return read.value;
  throw read.error;
};
