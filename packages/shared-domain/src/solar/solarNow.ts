// Live "Solar now" resolution — the SINGLE derivation of the
// producing / using-at-home / exporting triple consumed by both the Overview
// hero subline and any future live solar surface. Browser-safe (no Homey SDK).
//
// Boundary resolver: the input is the untrusted persisted-tracker slice
// (`lastPowerW` / `lastGenerationW` / `lastTimestamp`), so every field is
// finiteness-gated here and consumers receive either a fully-resolved triple
// or `null` — never a partial value.

import { POWER_SAMPLE_STALE_THRESHOLD_MS } from '../powerFreshness';
import { isFiniteNumber } from '../numberGuards';

/**
 * Minimum live generation (W) worth talking about. Below this the panels are
 * effectively asleep and the line is noise, so the resolver returns `null`.
 * Also reused as the "exporting is negligible" threshold for the
 * "— all used at home" phrasing.
 */
export const SOLAR_NOW_MIN_W = 50;

export type SolarNowInput = {
  /** Signed whole-home net grid power (W); negative while exporting. */
  lastPowerW?: number;
  /** Gross PV generation (W) carried by the last sample, if it had one. */
  lastGenerationW?: number;
  /** Timestamp (ms) of the last power sample. */
  lastTimestamp?: number;
};

export type SolarNow = {
  producingW: number;
  /**
   * Grid export right now = max(0, −net). Deliberately NOT capped at
   * `producingW`: in a battery home, discharge can push export above live PV
   * production, and the honest number is the metered one.
   */
  exportingW: number;
  /**
   * Production used at home right now = max(0, producing − exporting). The
   * floor makes the battery-export edge read as "using 0 at home" instead of
   * a negative wattage.
   */
  selfUsingW: number;
};

/**
 * Resolves the live solar triple, or `null` when there is nothing fresh and
 * material to show: missing/non-finite fields, a sample older than the shared
 * power staleness threshold, or generation under {@link SOLAR_NOW_MIN_W}.
 */
export const resolveSolarNow = (
  input: SolarNowInput | null | undefined,
  nowMs: number,
): SolarNow | null => {
  if (!input) return null;
  const { lastPowerW, lastGenerationW, lastTimestamp } = input;
  if (!isFiniteNumber(lastPowerW) || !isFiniteNumber(lastGenerationW) || !isFiniteNumber(lastTimestamp)) {
    return null;
  }
  if (nowMs - lastTimestamp >= POWER_SAMPLE_STALE_THRESHOLD_MS) return null;
  if (lastGenerationW < SOLAR_NOW_MIN_W) return null;
  const producingW = lastGenerationW;
  const exportingW = Math.max(0, -lastPowerW);
  const selfUsingW = Math.max(0, producingW - exportingW);
  return { producingW, exportingW, selfUsingW };
};

// Non-breaking space binds each number to its unit (the chart-readout
// measurement convention): at 320 px the subline may wrap, but only between
// phrases — never between «2.1» and «kW».
const formatKw = (watts: number): string => `${(watts / 1000).toFixed(1)}\u00A0kW`;

/**
 * One-line "Solar now" summary. Vocabulary registered in
 * `notes/ui-terminology.md` § Solar; the line is inventoried in
 * `notes/overview-hero-spec.md`. Deliberately terse ("1.1 kW at home,
 * 2.1 kW exported") so it holds one line at 320 px — the verb-y long form
 * wrapped mid-clause.
 */
export const formatSolarNowSubline = (solarNow: SolarNow): string => {
  if (solarNow.exportingW < SOLAR_NOW_MIN_W) {
    return `Solar now ${formatKw(solarNow.producingW)} — all used at home`;
  }
  return `Solar now ${formatKw(solarNow.producingW)} — ${formatKw(solarNow.selfUsingW)} at home, `
    + `${formatKw(solarNow.exportingW)} exported`;
};
