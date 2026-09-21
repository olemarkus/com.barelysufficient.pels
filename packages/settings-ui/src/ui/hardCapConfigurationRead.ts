import type { SettingsUiHardCapConfigurationRead } from '../../../contracts/src/settingsUiApi.ts';

/** Classify the API bridge once; setup logic receives only the owner's resolved choice. */
export const classifyHardCapConfigurationRead = (value: unknown): SettingsUiHardCapConfigurationRead => {
  if (typeof value !== 'object' || value === null || !('state' in value) || value.state !== 'resolved') {
    return { state: 'unavailable' };
  }
  if (!('configured' in value) || typeof value.configured !== 'boolean') return { state: 'unavailable' };
  return { state: 'resolved', configured: value.configured };
};
