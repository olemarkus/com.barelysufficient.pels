/**
 * Classify the untrusted settings-API peak scalar at the browser boundary.
 * `null` is the genuine domain state "no completed quarter yet"; malformed,
 * negative, or absent values are unavailable and must not be rendered as data.
 */
export const classifyCapacityPeakKw = (value: unknown): number | null | undefined => {
  if (value === null) return null;
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
};
