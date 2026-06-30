import type { UnknownRecord } from './appDebugTypes';

export const isRecord = (value: unknown): value is UnknownRecord => (
  typeof value === 'object' && value !== null
);

export const asFiniteNumber = (value: unknown): number | null => (
  typeof value === 'number' && Number.isFinite(value) ? value : null
);

export const asString = (value: unknown): string | undefined => (
  typeof value === 'string' && value.length > 0 ? value : undefined
);

export const asTimestampString = (value: unknown): string | undefined => {
  if (typeof value === 'string' && value.length > 0) return value;
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString();
  if (typeof value === 'number' && Number.isFinite(value)) return new Date(value).toISOString();
  return undefined;
};
