import type { PowerTrackerState as SettingsUiPowerTrackerState } from '../../packages/contracts/src/powerTrackerTypes';
import type { SettingsUiPowerPayload } from '../../packages/contracts/src/settingsUiApi';
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
  if (typeof limitKw !== 'number' || !Number.isFinite(limitKw)) return undefined;
  if (typeof marginKw !== 'number' || !Number.isFinite(marginKw)) return undefined;
  if (periodMinutes !== 15 && periodMinutes !== 60) return undefined;
  return { limitKw, marginKw, periodMinutes };
};

export const projectCurrentMonthCapacityPeakForUi = (
  readPeak: (() => number | null) | undefined,
): SettingsUiPowerPayload['capacityPeak'] => {
  if (readPeak === undefined) return undefined;
  const peakKw = readPeak();
  if (peakKw === null) return { currentMonthQuarterPeakKw: null };
  if (!Number.isFinite(peakKw) || peakKw < 0) return undefined;
  return { currentMonthQuarterPeakKw: peakKw };
};

/** Omit capacity-control internals from the general settings-UI usage history payload. */
export const projectPowerTrackerForUi = (tracker: PowerTrackerState): SettingsUiPowerTrackerState => {
  const {
    capacityQuarter: _capacityQuarter,
    capacityMonthlyPeak: _capacityMonthlyPeak,
    ...history
  } = tracker;
  return history;
};
