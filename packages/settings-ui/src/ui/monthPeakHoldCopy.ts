import type { CapacityPeriodMinutes } from '../../../contracts/src/capacitySettings.ts';
import type { SettingsUiCapacityPeak } from '../../../contracts/src/settingsUi/power.ts';
import { HOME_LIMITS_REACTION_LABEL, HOME_LIMITS_REACTION_NOTE } from './homeLimitsCopy.ts';

// What the Limits & safety page says about "Follow this month's peak"
// (`capacity_follow_month_peak`), for the Main-home form and each meter area's
// editor. The runtime decides the cap it holds (`lib/power/heldCapacityLimit.ts`);
// the page restates that decision from the values it already shows: the switch,
// the hard cap, the period and this month's highest completed quarter.

/** A hard cap in the owner's own terms: "4 kW", "6.4 kW". */
export const formatHardCapKw = (kw: number): string => `${Number(kw.toFixed(1))} kW`;

/** This month's highest completed quarter when it is above the hard cap on the 15-minute period, else null. */
const monthPeakAboveHardCapKw = (
  hardCapKw: number,
  periodMinutes: CapacityPeriodMinutes,
  peak: SettingsUiCapacityPeak,
): number | null => (
  periodMinutes === 15 && peak.state === 'recorded' && peak.peakKw > hardCapKw ? peak.peakKw : null
);

/** This month's peak held in place of the owner's hard cap. */
export type MonthPeakHold = { heldKw: number; hardCapKw: number };

/** The month peak PELS holds instead of the hard cap, or null while the hard cap applies. */
export const resolveMonthPeakHold = (
  hardCapKw: number,
  periodMinutes: CapacityPeriodMinutes,
  followMonthPeak: boolean,
  peak: SettingsUiCapacityPeak,
): MonthPeakHold | null => {
  const heldKw = followMonthPeak ? monthPeakAboveHardCapKw(hardCapKw, periodMinutes, peak) : null;
  return heldKw === null ? null : { heldKw, hardCapKw };
};

/** The safe-pace summary's words around its value. */
export type SafePaceSummaryCopy = { label: string; note: string };

const DEFAULT_SAFE_PACE_SUMMARY: SafePaceSummaryCopy = {
  label: HOME_LIMITS_REACTION_LABEL,
  note: HOME_LIMITS_REACTION_NOTE,
};

/** While a month peak holds, the summary names it and the hard cap it stands in for. */
export const composeSafePaceSummaryCopy = (hold: MonthPeakHold | null): SafePaceSummaryCopy => (
  hold === null
    ? DEFAULT_SAFE_PACE_SUMMARY
    : {
      label: `This month PELS holds ${formatHardCapKw(hold.heldKw)}, your highest completed quarter so far. `
        + 'Safe pace starts each period at',
      note: `(that peak minus the safety margin). Your hard cap of ${formatHardCapKw(hold.hardCapKw)} `
        + 'applies again from the 1st of next month.',
    }
);

export const MONTH_PEAK_ABOVE_HARD_CAP_NOTE = 'Above your hard cap. '
  + 'Turn on Follow this month’s peak to let devices use it.';

/**
 * The line under the month's peak readout: only with the switch off and the
 * peak above the hard cap. While the peak holds, the safe-pace summary says so.
 */
export const composeMonthPeakStateLine = (
  hardCapKw: number,
  periodMinutes: CapacityPeriodMinutes,
  followMonthPeak: boolean,
  peak: SettingsUiCapacityPeak,
): string | null => (
  !followMonthPeak && monthPeakAboveHardCapKw(hardCapKw, periodMinutes, peak) !== null
    ? MONTH_PEAK_ABOVE_HARD_CAP_NOTE
    : null
);

/** What a Limits & safety page says about this month's peak: the hold, if any, and the line under the readout. */
export type MonthPeakReadout = { hold: MonthPeakHold | null; stateLine: string | null };

/** For a hard cap still being typed (`null`), the page says nothing about the peak. */
export const resolveMonthPeakReadout = (
  hardCapKw: number | null,
  periodMinutes: CapacityPeriodMinutes,
  followMonthPeak: boolean,
  peak: SettingsUiCapacityPeak,
): MonthPeakReadout => (hardCapKw === null ? { hold: null, stateLine: null } : {
  hold: resolveMonthPeakHold(hardCapKw, periodMinutes, followMonthPeak, peak),
  stateLine: composeMonthPeakStateLine(hardCapKw, periodMinutes, followMonthPeak, peak),
});
