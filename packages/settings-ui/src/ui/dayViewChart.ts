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
