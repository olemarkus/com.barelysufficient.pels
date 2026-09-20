import type { PowerTrackerState as SettingsUiPowerTrackerState } from '../../packages/contracts/src/powerTrackerTypes';
import type { SettingsUiCapacityPeak } from '../../packages/contracts/src/settingsUiApi';
import type { PowerTrackerState } from './trackerTypes';

export const projectCapacityPeakForUi = (peakKw: number | null): SettingsUiCapacityPeak => (
  peakKw === null ? { state: 'no_completed_quarter' } : { state: 'recorded', peakKw }
);

/** Omit capacity-control internals from the general settings-UI usage history payload. */
export const projectPowerTrackerForUi = (tracker: PowerTrackerState): SettingsUiPowerTrackerState => {
  const {
    capacityQuarter: _capacityQuarter,
    capacityMonthlyPeak: _capacityMonthlyPeak,
    ...history
  } = tracker;
  return history;
};
