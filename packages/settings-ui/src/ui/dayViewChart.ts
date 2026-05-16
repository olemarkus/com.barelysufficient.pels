export type DayViewBarState = 'past' | 'current' | 'warn';

export type DayViewSegment = {
  value: number;
  className?: string;
};

export type DayViewMarker = {
  value: number;
  className?: string;
  overWhenGreaterThan?: number;
  overClassName?: string;
};

export type DayViewBar = {
  label: string;
  shortLabel?: string;
  value: number;
  state?: DayViewBarState;
  title?: string;
  className?: string;
  stackClassName?: string;
  segments?: DayViewSegment[];
  marker?: DayViewMarker;
};

export const resolveLabelEvery = (count: number) => {
  if (count >= 24) return 4;
  if (count >= 16) return 3;
  if (count >= 12) return 2;
  return 1;
};

export const formatHourAxisLabel = (label: string) => {
  if (!label) return '';
  const trimmed = label.trim();
  if (!trimmed) return '';
  const separatorIndex = trimmed.indexOf(':');
  if (separatorIndex > 0) return trimmed.slice(0, separatorIndex);
  return trimmed;
};

/**
 * Build a palette object from a single `getComputedStyle` snapshot. Each chart
 * resolves 6-13 CSS variables when painting; reading them all off one cached
 * declaration avoids the per-variable forced-layout cost of repeatedly calling
 * `getComputedStyle`. Returns the empty string for any variable that is
 * undefined; chart code passes the result straight to ECharts which treats an
 * empty colour as "use library default".
 */
export const readChartPalette = <T extends Record<string, string>>(
  element: HTMLElement,
  mapping: { readonly [K in keyof T]: string },
): T => {
  const style = getComputedStyle(element);
  const palette = {} as Record<string, string>;
  for (const [key, variable] of Object.entries(mapping)) {
    palette[key] = style.getPropertyValue(variable).trim();
  }
  return palette as T;
};

// Allowed "nice" multipliers within a decade. Picked so the resulting top
// tick at `step * splitNumber` always lands on a number a user can read at a
// glance — multiples of 1/2/2.5/5 across all magnitudes (e.g. 0.1, 0.2, 0.25,
// 0.5, 1, 2, 2.5, 5, 10, 20, 25, 50, …).
const NICE_STEP_MULTIPLIERS = [1, 2, 2.5, 5, 10] as const;

const niceStep = (rawStep: number): number => {
  if (!Number.isFinite(rawStep) || rawStep <= 0) return 1;
  const exponent = Math.floor(Math.log10(rawStep));
  const magnitude = 10 ** exponent;
  const normalised = rawStep / magnitude;
  const niceMultiplier = NICE_STEP_MULTIPLIERS.find((m) => m >= normalised - 1e-9)
    ?? NICE_STEP_MULTIPLIERS[NICE_STEP_MULTIPLIERS.length - 1];
  return niceMultiplier * magnitude;
};

/**
 * Round a Y-axis max up to a value that is evenly divisible into `splitNumber`
 * nice intervals, so ECharts never produces an extra top tick wedged above the
 * prior gridline (the "pin to data max" anti-pattern: ticks `0, 1, 2, 3, 3.7`).
 *
 * Returns both the rounded max and the step size. `niceStep` picks the
 * smallest nice multiplier (1 / 2 / 2.5 / 5 / 10 × 10^k) that is at least
 * `dataMax / splitNumber`, guaranteeing `max = splitNumber * interval`.
 */
export const roundedAxisMaxToInterval = (
  dataMax: number,
  splitNumber: number,
): { max: number; interval: number } => {
  const splits = Math.max(1, Math.floor(splitNumber));
  const safeDataMax = Number.isFinite(dataMax) && dataMax > 0 ? dataMax : 1;
  const interval = niceStep(safeDataMax / splits);
  // Smooth lingering binary-float trail (e.g. 0.30000000000000004 → 0.3).
  const sanitisedInterval = Math.round(interval * 1e9) / 1e9;
  const sanitisedMax = Math.round(splits * sanitisedInterval * 1e9) / 1e9;
  return { max: sanitisedMax, interval: sanitisedInterval };
};

// Smallest 10^-k that still represents `interval` exactly. Returns 0 only
// when `interval` is itself an integer (5, 10, 20, …); a 2.5 step needs 1
// decimal, a 0.25 step needs 2 decimals. The 1e-9 tolerance absorbs binary
// float drift like 0.30000000000000004.
const decimalsForInterval = (interval: number): number => {
  if (!Number.isFinite(interval) || interval <= 0) return 0;
  for (let decimals = 0; decimals <= 6; decimals += 1) {
    const factor = 10 ** decimals;
    if (Math.abs(interval * factor - Math.round(interval * factor)) < 1e-9) {
      return decimals;
    }
  }
  return 2;
};

/**
 * Format a Y-axis tick to match the actual `interval` precision returned by
 * `roundedAxisMaxToInterval`. The helper can pick fractional steps (0.25,
 * 2.5, …), so a flat `Math.round` or `toFixed(1)` would mis-label ticks:
 * 2.5 as "3", 0.25 as "0.3". Returns the integer string when the interval
 * is whole; otherwise renders at the exact step precision with trailing
 * zeros stripped so 0.5 stays "0.5", not "0.50".
 */
export const formatAxisTick = (value: number, interval: number): string => {
  if (!Number.isFinite(value)) return '';
  const decimals = decimalsForInterval(interval);
  if (decimals === 0) return String(Math.round(value));
  const factor = 10 ** decimals;
  const rounded = Math.round(value * factor) / factor;
  if (Number.isInteger(rounded)) return String(rounded);
  return rounded.toFixed(decimals).replace(/\.?0+$/, '');
};
