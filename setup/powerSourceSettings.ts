import {
  classifyPowerSourceSetting,
  type ConfiguredPowerSourceRead,
  type PowerSource,
  type PowerSourceSettingClassification,
} from '../lib/power/powerSource';
import { readPowerSourceEvidence, type PowerSourceSettingsPort } from './powerSourceEvidence';

// The port type is declared with the domain (`lib/power/powerSource.ts`); this
// adapter re-exports it so existing importers keep their import site. One
// declaration, not two — a structurally identical local copy is free to drift.
export type { ConfiguredPowerSourceRead };

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
    return attachSuspectError(classifyPowerSourceSetting(readPowerSourceEvidence(settings)));
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
