import type { SettingsUiCapacityPeak } from '../../../contracts/src/settingsUi/power.ts';

/**
 * Classify the untrusted settings-API peak at the browser boundary. Anything
 * that is not one of the contract's shapes, a negative or non-finite peak
 * included, is `unavailable` and must not be rendered as data.
 */
export const classifyCapacityPeak = (value: unknown): SettingsUiCapacityPeak => {
  if (typeof value !== 'object' || value === null) return { state: 'unavailable' };
  const { state, peakKw, source } = value as { state?: unknown; peakKw?: unknown; source?: unknown };
  if (state === 'no_completed_quarter') return { state };
  if (state === 'recorded' && typeof peakKw === 'number' && Number.isFinite(peakKw) && peakKw >= 0
    && (source === 'tracked' || source === 'meter')) {
    return { state, peakKw, source };
  }
  return { state: 'unavailable' };
};

/** The Main home's readout note while PELS's own tracked quarters set the peak. */
export const TRACKED_CAPACITY_PEAK_NOTE = 'Based on readings PELS received, '
  + 'not your grid operator’s billing calculation.';
/** The readout note while the peak is the one the meter reports itself. */
export const METER_CAPACITY_PEAK_NOTE = 'Reported by your meter.';

/** The readout's note: the meter's own peak says so; otherwise the page's tracked-peak note. */
export const capacityPeakNote = (peak: SettingsUiCapacityPeak, trackedNote: string): string => (
  peak.state === 'recorded' && peak.source === 'meter' ? METER_CAPACITY_PEAK_NOTE : trackedNote
);

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
