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

/**
 * Round a kWh Y-axis max up to a tidy step so the auto-generated ticks render
 * at sensible values (0.5, 1.0, 1.2, …) instead of `maxValue * 1.08`. Falls
 * back to `1` when `dataMax` is non-finite or non-positive so the axis still
 * draws a sane scale on empty/invalid data.
 */
export const roundedKWhAxisMax = (dataMax: number): number => {
  if (!Number.isFinite(dataMax) || dataMax <= 0) return 1;
  if (dataMax <= 1) return Math.max(0.1, Math.ceil(dataMax * 10) / 10);
  if (dataMax <= 5) return Math.ceil(dataMax * 10) / 10;
  return Math.ceil(dataMax);
};
