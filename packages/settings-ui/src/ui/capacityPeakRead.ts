import type { SettingsUiCapacityPeak } from '../../../contracts/src/settingsUiApi.ts';

/**
 * Classify the untrusted settings-API peak at the browser boundary. Anything
 * that is not one of the contract's shapes, a negative or non-finite peak
 * included, is `unavailable` and must not be rendered as data.
 */
export const classifyCapacityPeak = (value: unknown): SettingsUiCapacityPeak => {
  if (typeof value !== 'object' || value === null) return { state: 'unavailable' };
  const { state, peakKw } = value as { state?: unknown; peakKw?: unknown };
  if (state === 'no_completed_quarter') return { state };
  if (state === 'recorded' && typeof peakKw === 'number' && Number.isFinite(peakKw) && peakKw >= 0) {
    return { state, peakKw };
  }
  return { state: 'unavailable' };
};

export const formatCapacityPeak = (peak: SettingsUiCapacityPeak): string => {
  switch (peak.state) {
    case 'recorded':
      return `${peak.peakKw.toFixed(2)} kW`;
    case 'no_completed_quarter':
      return 'No completed quarter yet';
    case 'unavailable':
      return 'Peak unavailable';
    default: {
      const exhaustive: never = peak;
      return exhaustive;
    }
  }
};
