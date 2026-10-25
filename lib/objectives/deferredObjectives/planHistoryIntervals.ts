import { isUnknownRecord } from '../../../packages/shared-domain/src/recordGuards';
import { isFiniteNumber } from '../../../packages/shared-domain/src/numberGuards';

const HOUR_MS = 60 * 60 * 1000;

// Only the persisted boundary interprets an omitted endpoint as a legacy
// hour. Explicit endpoints, including malformed ones, are left to validation.
export const migrateLegacyHistoryIntervals = (raw: unknown): unknown => {
  if (!Array.isArray(raw)) return raw;
  return raw.map((entry: unknown) => {
    if (!isUnknownRecord(entry) || 'endsAtMs' in entry || !isFiniteNumber(entry.atMs)) return entry;
    return { ...entry, endsAtMs: entry.atMs + HOUR_MS };
  });
};
