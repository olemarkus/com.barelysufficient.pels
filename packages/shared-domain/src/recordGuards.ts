/**
 * The record guards, for the runtime and the settings UI alike: a record is a
 * non-null object that is not an array. Import them rather than hand-rolling
 * another copy.
 */
export type UnknownRecord = Record<string, unknown>;

export const isUnknownRecord = (value: unknown): value is UnknownRecord => (
  typeof value === 'object' && value !== null && !Array.isArray(value)
);

/** The value as a record, or null when it is not one. */
export const asUnknownRecord = (value: unknown): UnknownRecord | null => (
  isUnknownRecord(value) ? value : null
);
