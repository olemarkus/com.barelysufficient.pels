export function formatBinaryState(value: boolean | undefined): string {
  if (value === true) return 'on';
  if (value === false) return 'off';
  return 'unknown';
}

export function formatTargetValue(value: unknown, unit?: string | null): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 'unknown';
  return `${value}${unit || ''}`;
}
