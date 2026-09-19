import type { PowerTrackerState as SettingsUiPowerTrackerState } from '../../packages/contracts/src/powerTrackerTypes';
import type {
  SettingsUiCapacityPeak,
  SettingsUiPowerPayload,
} from '../../packages/contracts/src/settingsUiApi';
import { isCapacityPeriodMinutes } from '../../packages/shared-domain/src/settings/capacityPeriod';
import { isFiniteNumber } from '../utils/appTypeGuards';
import type { PowerTrackerState } from './trackerTypes';

export const projectMainCapacityScalarsForUi = (
  value: unknown,
): SettingsUiPowerPayload['mainCapacityScalars'] => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const { limitKw, marginKw, periodMinutes } = value as {
    limitKw?: unknown;
    marginKw?: unknown;
    periodMinutes?: unknown;
  };
  if (!isFiniteNumber(limitKw) || !isFiniteNumber(marginKw) || !isCapacityPeriodMinutes(periodMinutes)) {
    return undefined;
  }
  return { limitKw, marginKw, periodMinutes };
};

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
