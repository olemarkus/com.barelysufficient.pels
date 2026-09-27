import type { PowerTrackerState as SettingsUiPowerTrackerState } from '../../packages/contracts/src/powerTrackerTypes';
import type { SettingsUiCapacityPeak, SettingsUiPowerReadings } from '../../packages/contracts/src/settingsUiApi';
import { hasPowerMeasurement, resolveDisplayedPowerUpdateMs } from './lastTotalPower';
import type { PowerTrackerState } from './trackerTypes';

export const projectCapacityPeakForUi = (peakKw: number | null): SettingsUiCapacityPeak => (
  peakKw === null ? { state: 'no_completed_quarter' } : { state: 'recorded', peakKw }
);

/**
 * Omit capacity-control internals from the general settings-UI usage history
 * payload: the open quarter, the month's peak, and the held reading the meter
 * is judged by (its verdict reaches the UI only as the readings stamp).
 */
export const projectPowerTrackerForUi = (tracker: PowerTrackerState): SettingsUiPowerTrackerState => {
  const {
    capacityQuarter: _capacityQuarter,
    capacityMonthlyPeak: _capacityMonthlyPeak,
    heldReading: _heldReading,
    ...history
  } = tracker;
  return history;
};

/**
 * The readings fact, for the pull and the push alike: a measurement is
 * latched (`hasPowerMeasurement`), and its stamp is the displayed
 * power-update stamp (`resolveDisplayedPowerUpdateMs`). A meter whose driver
 * keeps repeating one value while the home's metered load moves therefore
 * reads as having sent nothing new. The UI never re-derives this from
 * tracker fields or persisted-blob fallbacks.
 */
export const resolvePowerReadingsForUi = (tracker: PowerTrackerState): SettingsUiPowerReadings => {
  const lastPowerUpdateMs = resolveDisplayedPowerUpdateMs(tracker);
  return hasPowerMeasurement(tracker) && lastPowerUpdateMs !== undefined
    ? { state: 'received', lastPowerUpdateMs }
    : { state: 'never' };
};
