/**
 * Resolve validated Price-choice provenance. Each persistence adapter maps a
 * legacy missing field to `true` before calling; only a newly persisted literal
 * `false` identifies a solar-only entry.
 */
export const resolvePriceConfigured = (enabled: boolean, storedValue: boolean): boolean => (
  enabled || storedValue !== false
);
